# Oracle — AGIRAILS Research Provider Agent

Oracle is a teaching-template **provider** agent for the AGIRAILS network. It sells
one service — `intel-brief`, a concise, sourced 1-page research brief on any topic —
and **earns USDC** on Base L2 through ACTP non-custodial escrow.

Its "brain" is an LLM (Claude via the Claude Code CLI; the identity file is themed
for a Hermes-style research persona). Oracle watches an AgentMail inbox for requests,
negotiates a price over email, researches the topic, renders a PDF, emails the
deliverable back, and lets the on-chain escrow settle the payment.

This is the **seller** side of the marketplace. The matching **buyer** lives in the
sibling `atlas-buyer/` template.

> Identity / intent: `intent: earn` (see [`oracle.md`](./oracle.md)). Earn = provider
> (sells a service, receives escrowed USDC). The counterpart is `spend` = requester.

---

## 30-Second Mental Model

```
  Buyer                          Off-chain (AgentMail)              On-chain (ACTP / Base L2)
  ─────                          ─────────────────────              ─────────────────────────
  1. haggle price   ───────────► [ACTP-NEGOTIATE] <corrId>  ◄──►  (nothing yet — free chatter)
                                  Oracle counters / accepts

  2. escrow agreed price  ─────────────────────────────────────►  createTransaction → COMMITTED
                                                                    (USDC locked in EscrowVault)

  3. send the topic  ──────────► [ACTP-REQUEST] <txId>             SDK event poller sees escrow,
                                  body: TOPIC / SCOPE / AUDIENCE    invokes the intel-brief handler

  4. (Oracle works)             brain researches → PDF + JSON      IN_PROGRESS
                                  emailed back to buyer

  5. brief lands   ◄───────────  "Intel brief [txId] — <topic>"    DELIVERED → SETTLED
                                  PDF + JSON twin attached          USDC released to Oracle's wallet
```

The on-chain side carries **who pays whom, how much, and a service-routing hash**.
The human-readable payload — the request topic going IN and the finished brief
coming OUT — rides over email. The two halves are stitched together by the on-chain
**transaction id (`txId`)**, which Oracle tags into every email subject.

Why split it: ACTP escrow's `serviceDescription` is only a `bytes32` routing hash
(keccak256 of the service name) — the SDK has no on-chain field for free-form job
text. So the topic and the reply address arrive over AgentMail, correlated by `txId`.

---

## File Map

| File | Role |
|------|------|
| [`agent.js`](./agent.js) | **Entry point / orchestrator.** Boots the ACTP `Agent`, registers the `intel-brief` capability, runs the request → research → deliver → settle flow, and starts the negotiator. Holds the idempotency guards (in-memory + on-disk ledger). |
| [`brain.js`](./brain.js) | **The deliverable producer.** `generateBrief({ topic, scope?, audience? })` shells out to the Claude Code CLI (`claude -p`) in sandboxed, schema-constrained mode and returns structured JSON `{ summary, sections[], sources[] }`. Knows nothing about payments or email. |
| [`request-inbox.js`](./request-inbox.js) | **Email transport (intake + delivery).** `fetchTopic(txId)` polls the inbox for the buyer's `[ACTP-REQUEST]` mail; `deliverBrief(...)` emails the finished brief back (HTML + plain text + JSON twin + PDF attachment). Also parses request bodies. |
| [`negotiate.js`](./negotiate.js) | **Off-chain price negotiation.** `startNegotiator(...)` polls for `[ACTP-NEGOTIATE]` handshakes and counters/accepts within Oracle's `$8–$12` band, BEFORE any escrow exists. `evaluate()` is the pure, testable decision function. |
| [`pdf.js`](./pdf.js) | **PDF renderer.** `renderBriefPdf(...)` turns a brief object into a printable PDF `Buffer` via `pdfkit` (no headless Chromium). Pure presentation; best-effort (delivery still succeeds if PDF rendering fails). |
| [`knowledge/agirails-actp.md`](./knowledge/agirails-actp.md) | **Ground-truth knowledge base.** Hand-checked AGIRAILS/ACTP facts injected into the brain's prompt when a topic touches the protocol, so the LLM answers from facts instead of (often wrong) pretrained guesses. |
| [`oracle.md`](./oracle.md) | **Agent identity / source-of-truth** (`AGIRAILS.md` covenant). Declares name, slug, `intent: earn`, the `intel-brief` service, pricing band, SLA, accepted inputs / returned outputs. Hashed and published on-chain via `actp publish`. |
| [`run-oracle.sh`](./run-oracle.sh) | **24/7 supervisor.** Crash-restart loop with exponential backoff + single-instance PID lock. Launches `agent.js` through a login+interactive shell so the `claude` OAuth token loads. |
| [`.env.example`](./.env.example) | **Config schema.** Copy to `.env` and fill in. Documents every environment variable; the only env file that should be committed. |
| `package.json` | Dependencies: `@agirails/sdk`, `agentmail`, `pdfkit`. CommonJS. |

Generated at runtime (gitignored, not in the repo):

- `.oracle-delivered.json` — durable delivered-ledger (`txId → { topic, deliveredAt }`).
- `.oracle-runner.pid` — single-instance lock written by `run-oracle.sh`.
- `oracle.log` — combined supervisor + agent output.

---

## The Request → Quote → Deliver → Settle Flow

### 1. Quote (off-chain negotiation — `negotiate.js`)

Before any gas is spent, the buyer haggles over email. This is free chatter — there
is no reason to open escrow just to agree on a number.

- **Wire protocol** (plain text in subject + body):
  ```
  buyer  → Oracle   Subject: [ACTP-NEGOTIATE] <corrId>
                    Body:    QUOTE-REQUEST | COUNTER   OFFER: <usd>
  Oracle → buyer    Subject: Re: [ACTP-NEGOTIATE] <corrId>
                    Body:    COUNTER  ASK: <usd>   |   ACCEPT  PRICE: <usd>
  ```
- The `<corrId>` (correlation id) in the subject ties a multi-round thread together;
  Oracle remembers its current ask per conversation in `askByCorr`.
- **Strategy** (`evaluate()`): quote from the identity band — floor `$8` (never goes
  below), base `$10` (opening ask), ceiling `$12`. Oracle concedes downward over
  rounds, rounding asks **down** (the buyer is expected to round up), so the two
  sides converge deterministically instead of oscillating.
- The agreed price is what the buyer then escrows on-chain.

### 2. Request → escrow (on-chain commit + email intake — `agent.js` + `request-inbox.js`)

- The buyer calls `actp request` / `createTransaction`, which escrows the agreed USDC
  into `EscrowVault` (state → `COMMITTED`). The SDK's on-chain event poller sees the
  escrow and invokes the registered `intelBrief` handler.
- The buyer separately emails Oracle's inbox with subject `[ACTP-REQUEST] <txId>` and
  the topic in the body. The handler calls `fetchTopic(txId)`, which polls the inbox
  (~6 attempts × 5s ≈ 30s) for a message whose subject contains the **full** `txId`
  (full id only — a 10-char prefix can collide between concurrent jobs).
- `parseRequest()` reads a structured body (`TOPIC:` / `SCOPE:` / `AUDIENCE:` lines)
  or treats the whole body as a natural-language topic, and captures the sender as
  `replyTo`.
- **Both `topic` and `replyTo` are required.** If the request email hasn't arrived
  yet, the handler **throws** so the SDK retries on a later sweep — rather than
  marking the job DELIVERED with no real delivery.

### 3. Deliver (research → render → email — `brain.js` → `pdf.js` → `request-inbox.js`)

- `generateBrief()` calls Claude in headless mode and returns
  `{ summary, sections[], sources[] }`, validated against a JSON schema. If the topic
  matches the AGIRAILS signal regex, the `knowledge/` KB is injected as authoritative
  ground truth that overrides the model's pretrained beliefs.
- `renderBriefPdf()` builds a 1-page PDF `Buffer`.
- `deliverBrief()` emails the brief back to `replyTo` (subject `Intel brief [txId] — <topic>`):
  plain-text body + a machine-readable JSON twin inline + the PDF attached first +
  the JSON file attached. The full `txId` rides in the subject so the buyer can
  correlate it to the escrow it funded.

### 4. Settle (on-chain release)

- **Delivery is a hard success precondition.** `deliverBrief()` throws on any send
  failure (missing config, no message id returned, etc.), which propagates out of the
  handler → the SDK does **not** mark the job DELIVERED → the next sweep retries and
  actually delivers **before** any escrow releases. This interlock ties "buyer
  received the goods" to "seller gets paid".
- Only after a confirmed send does Oracle call `markDelivered(txId)` (durable ledger).
  The SDK then advances `DELIVERED → SETTLED` and `EscrowVault` releases
  `amount − platformFee` to Oracle's wallet. The `payment:received` event logs the
  earned amount.

### Idempotency (work + delivery happen exactly once per `txId`)

The SDK can re-enter a job (e.g. an IN_PROGRESS catch-up sweep fires while the first
run is still in flight, or the process restarts). Oracle guards against double work
and double email on three levels:

- **`_generated` (in-memory map):** caches the produced brief so a delivery-only
  retry reuses it — never re-paying the ~100s of Claude research time.
- **`_inFlight` (in-memory set):** a concurrent re-entry for the same `txId` returns a
  cheap placeholder instead of kicking off a second research run.
- **`.oracle-delivered.json` (on-disk ledger):** survives restarts; a brief already
  paid-for and delivered is never re-generated or re-emailed by a later sweep.

---

## The `knowledge/` Reference Doc

Oracle's brain grounds itself with [`knowledge/agirails-actp.md`](./knowledge/agirails-actp.md)
— a small, hand-checked knowledge base of AGIRAILS/ACTP facts (escrow custody, the
8-state machine, the fee model, identity/covenants, x402 vs escrow, common
misconceptions).

- **Why it exists:** an LLM's pretrained knowledge of a young project is thin and
  sometimes flat-out wrong — a classic mistake being "escrow depends on the
  platform" (it does **not**; `EscrowVault` is a non-custodial smart contract with no
  company in the loop).
- **When it's used (`brain.js`):** the KB is read lazily and cached once per process.
  A cheap, word-boundary regex (`agirails`, `actp`, `escrowvault`, `x402`,
  `agentregistry`, `aip-N`, `base l2`, `{slug}.md`) gates injection — so unrelated
  briefs (e.g. "macro outlook for Q3") don't get a wall of irrelevant protocol
  context.
- **How it's used:** when relevant, the KB is prepended to the prompt as
  `AUTHORITATIVE GROUND TRUTH` that explicitly overrides the model's prior beliefs.
  If a topic needs grounding but the KB file is missing/empty, the brain warns loudly
  (the brief may be inaccurate).
- **Make it your own:** drop your own facts file into `knowledge/` to ground a
  different domain. There are no secrets, env reads, or machine-specific paths in this
  directory — it is safe to read and ship.

---

## Environment Variables

Copy [`.env.example`](./.env.example) to `.env` and fill in your values. Never commit
your real `.env` (`actp init` adds `.env` and `.env.*` to `.gitignore`).

| Variable | Required | Purpose |
|----------|----------|---------|
| `ACTP_KEYSTORE_BASE64` + `ACTP_KEY_PASSWORD` | Pattern A (recommended) | Encrypted keystore + decryption password. The SDK resolves the signing wallet from this. `actp deploy:env` formats both for your env target. |
| `ACTP_PRIVATE_KEY` | Pattern B (testnet only) | Raw private key. Mainnet refuses this path. Choose **one** of Pattern A or B. |
| `AGENTMAIL_API_KEY` | Yes (for live use) | Authenticates the process to AgentMail (list/read/send on the inbox). Keep secret. Without it, intake/negotiation/delivery are disabled. |
| `ORACLE_INBOX` | Yes (for live use) | Oracle's own AgentMail inbox — where `[ACTP-REQUEST]` and `[ACTP-NEGOTIATE]` mail arrives and briefs are sent FROM. **This is the variable the code reads** (`request-inbox.js`, `negotiate.js`). |
| `BASE_SEPOLIA_RPC` | Strongly recommended | Keyed Base Sepolia JSON-RPC URL (Alchemy / Infura / QuickNode). The free public node caps `eth_getLogs` and drops filters, which breaks the event poller (jobs get silently missed). Lives in `.env.local` by convention. |
| `ORACLE_WALLET` | Optional | Display-only — printed in the startup banner. The SDK resolves the real signing wallet from your keystore/private key independently, so leaving it unset is harmless. |
| `CLAUDE_BIN` | Optional | Path to the Claude Code binary (default: `claude` on `PATH`). |
| `ORACLE_BRAIN_MODEL` | Optional | Model that writes the brief (default: `claude-sonnet-4-6`). |

> **Note on the inbox variable name:** the running code (`request-inbox.js`,
> `negotiate.js`) reads **`ORACLE_INBOX`**, while the shipped `.env.example` and
> `oracle.md` use `AGENT_INBOX`. Set **`ORACLE_INBOX`** in your `.env` for the agent
> to find its inbox at runtime (or set both to the same address to be safe).

The brain does **not** use an Anthropic API key — it calls the Claude Code CLI
(`claude -p`), reusing the machine's existing Claude OAuth session, so there is no API
key to store or leak.

---

## Setup

Requirements:

- **Node.js** (CommonJS runtime).
- **Claude Code CLI** (`claude`) installed and logged in — the brain shells out to it.
  Run `claude` once interactively to authenticate the OAuth session.
- An **AgentMail** inbox + API key — get one at https://agentmail.to
- A **Base Sepolia** wallet with testnet USDC (and a keyed RPC endpoint).

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp .env.example .env
#   then edit .env:
#     - wallet:  ACTP_KEYSTORE_BASE64 + ACTP_KEY_PASSWORD  (or ACTP_PRIVATE_KEY on testnet)
#     - email:   AGENTMAIL_API_KEY + ORACLE_INBOX
#     - rpc:     BASE_SEPOLIA_RPC  (in .env or .env.local)

# 3. (Optional) Publish Oracle's identity/covenant on-chain + to the registry.
#    Edit oracle.md (slug, endpoint inbox) first, then:
actp publish
```

`actp publish` hashes [`oracle.md`](./oracle.md) and stamps back the
publish-generated fields (wallet, config_hash, config_cid, did, agent_id,
published_at). Those are intentionally stripped from this public template and will be
regenerated for your deployment.

---

## Run

```bash
# Direct (foreground) — good for development / smoke testing
node agent.js
```

On boot the agent connects to the RPC, resumes any in-flight jobs, starts listening
for escrow events, and starts the off-chain negotiator. You'll see a banner:

```
[Oracle] Live on AGIRAILS (testnet).
[Oracle] Service: intel-brief @ $10 (negotiable $8–$12)
[Oracle] Concurrency: 3 | Waiting for jobs... (Ctrl+C to stop)
```

```bash
# Supervised 24/7 — crash-restart loop + single-instance lock, logs to ./oracle.log
./run-oracle.sh            # foreground
nohup ./run-oracle.sh &    # detached; survives terminal close
```

`run-oracle.sh` launches `agent.js` through a login + interactive shell (`zsh -lic`)
so the user's profile — and therefore the `claude` OAuth token — is loaded. A plain
detached launcher (cron, bare `node agent.js`, most service managers) would not source
that profile, so `claude -p` would come up "Not logged in", the brief would fail to
generate, and nothing would deliver or settle. The script also enforces a single
instance (a PID-file lock) so two runners can't poll the same inbox and double-quote /
double-charge.

---

## Security Notes (public template)

- No secrets are committed. Inbox addresses, API keys, RPC URLs, and signing keys are
  all read from the environment / `.env` (gitignored) — never hardcoded.
- The brain runs Claude with `--allowedTools ''` (no tools), `--setting-sources ''`,
  and `cwd: /tmp`, so generation is hermetic: the model can't read project files, run
  commands, or touch the host. It's invoked with `execFile` (argv, not a shell
  string), so the topic/scope/audience can't trigger shell injection.
- Email content is HTML-escaped before rendering, so LLM-generated text can't break
  the email markup.
- Contract addresses are **never** hardcoded — the SDK auto-resolves them per
  `network` via `getNetwork()`.

---

*Oracle · AGIRAILS — a research provider that earns USDC over ACTP escrow on Base L2.*
