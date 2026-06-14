# Atlas — buyer agent

Atlas is an email-driven, autonomous **procurement / buyer** agent for the AGIRAILS
agent economy. A human ("the principal") emails Atlas in plain language; Atlas reads
the mail, decides whether it is just conversation or a real request to *commission*
work, and — when it is a commission — sources an **intel brief** from a provider
agent (e.g. "Oracle"), pays for it by locking USDC in an on-chain **ACTP escrow** on
Base, receives the deliverable, and either settles (releases payment) autonomously or
holds the funds for the principal's explicit approval.

Its AGIRAILS identity declares `intent: pay` (see [`atlas.md`](atlas.md)): Atlas is a
requester, not a provider.

```
Principal ──email──▶ Atlas ──negotiate (email)──▶ Oracle (provider)
   ▲                  │  └──ACTP escrow (USDC, Base)──▶ on-chain
   │                  │
   └──brief + receipt─┘  (settle = release, or hold for "approve")
```

---

## What Atlas does, end to end

1. **Listen.** A long-running poller watches Atlas's own AgentMail inbox for new mail.
2. **Understand.** An LLM "brain" classifies each email as ordinary `chat` or a
   `commission` (extracting a *topic* and a *budget*), and detects whether the
   principal asked to review before payment is released.
3. **Negotiate.** For a commission, Atlas haggles a price with the provider over a
   plain-text email handshake, never exceeding the principal's budget.
4. **Escrow.** Atlas locks the agreed USDC in an ACTP escrow via the `actp` CLI,
   emails the provider the *topic* keyed by the on-chain transaction id, and waits
   for delivery. If the provider never delivers, the escrow is cancelled and refunded
   (no stranded funds).
5. **Deliver.** On delivery, Atlas fetches the brief from its inbox, renders it as a
   PDF, and emails it (inline + PDF/JSON attachments) to the principal.
6. **Settle or hold.**
   - **Autonomous mode** — Atlas settles immediately (DELIVERED → SETTLED on-chain),
     releasing payment to the provider, and pushes an AGIRAILS receipt.
   - **Review mode (mode A)** — Atlas *holds* the delivered escrow and waits for the
     principal to reply `approve` (release) or `reject` (withhold). The principal
     keeps the brief either way; a withheld escrow returns to them after the on-chain
     dispute/deadline window.

Every step is persisted to a durable JSON file, so a crash or redeploy never strands a
funded escrow: on boot Atlas reconciles all in-flight transactions against the chain
and resumes them.

> **Note on quote signatures.** This template negotiates price as a plain-text
> agent-to-agent email handshake (`negotiate.js`) — there is **no** EIP-712 quote
> signature verification step in the code. The only EIP-712 signing here is Atlas's
> own *settlement receipt* (`pushReceiptOnSettled`, signed by the keystore EOA in
> `escrow.js`). Trust comes from the on-chain held-escrow pattern (delivery does not
> auto-pay) rather than from a signed quote.

---

## File map

| File | Role |
|------|------|
| [`listener.js`](listener.js) | **Entry point.** The 24/7 email loop: polls the AgentMail inbox, runs the approve/reject gate, calls the brain, drives the commission worker, and reconciles in-flight escrows on boot + every 5 min. Owns the full control flow. |
| [`brain.js`](brain.js) | **Cognition (pure).** `understand()` classifies an email as `chat` vs `commission` and extracts `{ topic, budget, review, reply }`; `buyerReply()` writes a plain reply. Both shell out to the local `claude` CLI (no API key). Hardened against prompt injection; never throws. |
| [`negotiate.js`](negotiate.js) | **Price discovery.** `negotiate()` runs a plain-text `[ACTP-NEGOTIATE]` email handshake with the provider, splitting the difference until convergence (≤ budget). Falls back to the full budget if the provider stays silent. No funds move here. |
| [`escrow.js`](escrow.js) | **The money path (held pattern).** `escrowHold()` funds the escrow, emails the topic, waits for DELIVERED, fetches the brief, and cancels+refunds on no-show. `settle()` releases funds and confirms SETTLED *on-chain* (not by stdout), then pushes the receipt. `txStatus()` / `fetchBrief()` / `cancelEscrow()` are recovery primitives used by the reconciler. |
| [`commerce.js`](commerce.js) | **Autonomous one-shot helper.** `commission()` is a self-contained `actp request` flow (escrow → deliver → auto-settle) that streams ACTP states off the CLI and pulls the delivered brief. A simpler, fully-autonomous alternative to the held `escrow.js` path. |
| [`state.js`](state.js) | **Durable, restart-safe store.** A dependency-free JSON file holding three maps: `seen` (processed message ids), `committed` (one email → one escrow, keyed by content-derived `idemKey`), and `pending` (delivered escrows awaiting approval, keyed by sender). Gives Atlas exactly-once + crash recovery. |
| [`pdf.js`](pdf.js) | **Deliverable rendering.** `renderBriefPdf()` turns a structured brief (`{ summary, sections[], sources[] }`) into a branded PDF `Buffer` via `pdfkit`, stamped with the on-chain txId. Pure, no network/SDK. |
| [`atlas.md`](atlas.md) | **AGIRAILS identity (AGIRAILS.md).** YAML frontmatter (`name`, `slug`, `intent: pay`, `servicesNeeded`, `network`, `budget`) consumed by `actp publish`. Publish-stamped fields are intentionally stripped from this public template. |
| [`test-unit.js`](test-unit.js) | **Deterministic unit tests** (no network, no funds): idempotency keys, state CRUD + merge, pending lifecycle, seen-dedup, persistence across a simulated restart, the approve/reject gate (quoted-history + bilingual EN/HR), and the `isConversational` filter. |
| [`test-integration.js`](test-integration.js) | **Live end-to-end test** against a real provider: `negotiate → escrowHold → delivery → on-chain settle → public /verify`. Spends ~$9 real testnet USDC; takes ~2–3 min. |
| [`run-atlas.sh`](run-atlas.sh) | **Supervisor.** Keeps `listener.js` alive forever with exponential backoff, a single-instance PID lock, and a login shell so the `claude` CLI's PATH + OAuth session are inherited. |
| [`healthcheck.sh`](healthcheck.sh) | **Health probe** (report-only, CI/cron-friendly): checks the runner PIDs are alive and that the `claude` CLI is authenticated and answering. |
| [`package.json`](package.json) | npm manifest. Deps: `@agirails/sdk`, `agentmail`, `dotenv`, `pdfkit`. Scripts: `start`, `test`, `test:unit`, `test:integration`. |
| [`.env.example`](.env.example) | Template for all runtime configuration. **Copy to `.env` and fill in — never commit your real `.env`.** |

---

## Email-driven control flow

Everything is orchestrated by `listener.js`. One inbound email flows through `handle()`:

```
pollOnce()  ── poll inbox (oldest-first), skip seen / non-conversational mail,
   │           respect the MAX_CONCURRENT back-pressure cap, mark-seen BEFORE handling
   ▼
handle(email)
   │
   ├─ 1. Pending gate (mode A): is a HELD escrow awaiting THIS sender?
   │      strip quoted history → test isApproval / isReject (EN + HR)
   │        • approve → approveAndSettle()  → settle() → DELIVERED→SETTLED + receipt
   │        • reject  → withhold; mark REJECTED; escrow returns after dispute window
   │        • both    → ask for a one-word answer
   │        • neither → fall through to step 2
   │
   ├─ 2. Understand (brain): understand({ from, subject, body, recent })
   │        recent = sender's last commission topic (de-dupes "thanks/follow-up"
   │        so a chatty thread can't trigger a second paid commission)
   │
   ├─ 3a. kind = "commission" (with a real topic):
   │        idemKey(from, subject, body) → committed ledger
   │          • already in-flight/settled → reply with status, do NOT re-order
   │          • new → clamp budget to [1, MAX_BUDGET], persist PENDING, ack the
   │                   principal, then runCommission(...)
   │
   └─ 3b. kind = "chat": send the brain's warm reply. No money moves.
```

`runCommission()` is the worker (runs off the poll loop):

```
negotiate(topic, budget)            → agreed price (≤ budget; abort if < ORACLE_FLOOR)
   ▼
escrowHold(topic, price)            → COMMITTED → IN_PROGRESS → DELIVERED
   │                                   (no-show → CANCELLED + refund)
   ▼
render PDF + inline + attachments
   ▼
review? ── yes ─▶ setPending(sender), keep escrow HELD, email "approve to release"
        └─ no  ─▶ settle() now → SETTLED on-chain → email brief + receipt
```

Two background safety nets keep funds honest across restarts:

- **Boot priming.** On a *fresh* state file, existing inbox messages are marked seen
  so historical mail doesn't trigger a flood of commissions. A returning Atlas keeps
  its seen-set and reconciles instead.
- **`reconcile()`** (on boot + every 5 min) re-checks every persisted pending and
  committed transaction against the chain: clears stale pendings, marks settled ones,
  and re-arms any escrow that reached DELIVERED while Atlas was down (re-fetching the
  brief and re-sending the approval request).

**Loop-avoidance:** `isConversational()` ignores `@agentmail.to` senders and
`[ACTP-*]` / "Intel brief" subjects, so Atlas never talks to itself, the provider, or
system mail.

---

## Environment variables

All identity and secrets come from the environment — the repo ships **zero** hardcoded
wallets, inboxes, or keys. Copy [`.env.example`](.env.example) to `.env` and fill in:

| Variable | Required | Purpose |
|----------|----------|---------|
| `ORACLE_ADDR` | yes | Provider's on-chain wallet — escrow releases here on settlement. |
| `BUYER_WALLET` | yes | Atlas's own on-chain requester (Smart Wallet) address that holds escrowed funds; stamped on receipts and used in the explorer link. |
| `BUYER_INBOX` | yes | Atlas's AgentMail inbox — work requests are sent *from* here and the brief comes back *here*. The listener fails closed if unset. |
| `ORACLE_INBOX_ADDR` | yes | Provider's AgentMail inbox — where the topic / negotiation is sent *to*. |
| `AGENTMAIL_API_KEY` | yes | Authenticates this process to AgentMail. Keep secret. |
| `SERVICE_NAME` | no (default `intel-brief`) | Service slug; its `keccak256` routes escrow to the provider's matching handler. |
| `BASE_SEPOLIA_RPC` | no (defaults to a public node) | Base Sepolia JSON-RPC; supply your own (Alchemy/Infura) for production rate limits. |

Additional runtime knobs read from the environment (sensible defaults, no `.env`
entry needed):

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_BIN` | `claude` | Path to the Claude CLI the brain shells out to. |
| `BUYER_BRAIN_MODEL` | `claude-sonnet-4-6` | Model the brain uses. |
| `BRAIN_TIMEOUT_MS` | `300000` | Per-call timeout for the brain. |
| `POLL_MS` | `8000` | Inbox poll interval. |
| `MAX_CONCURRENT` | `4` | In-flight commissions cap (back-pressure). |
| `MAX_BUDGET` | `25` | Hard cap on spend per commission (defeats prompt-injected budget inflation). |
| `ORACLE_FLOOR` | `8` | Provider's minimum; below it, Atlas aborts cleanly with no funds moved. |
| `ATLAS_STATE_PATH` | `.atlas-state.json` (next to `state.js`) | Durable state location; point at a mounted volume for production. |

> **Security:** the brain never receives an API key — it reuses the developer's local
> `claude` OAuth session. Email bodies are wrapped in `<<<EMAIL>>> … <<<END>>>` fences
> and declared untrusted, the CLI runs tool-less in `/tmp`, and budgets are clamped at
> two layers (brain → `[1,100]`, listener → `[1, MAX_BUDGET]`).

---

## Setup

Prerequisites:

- **Node.js** (CommonJS; v18+ recommended).
- The **`claude` CLI** installed and logged in (on PATH, or set `CLAUDE_BIN`). The
  brain uses your existing Anthropic OAuth session — no API key.
- An **AgentMail** account with an inbox for Atlas (and access to the provider's
  inbox). Get one at <https://agentmail.to>.
- A **Base Sepolia** requester wallet — created by `actp init` into the local
  `actp` keystore in this directory. **No manual funding on testnet:** the wallet
  is a gasless ERC-4337 Smart Wallet (gas is paymaster-sponsored) and ~1,000 test
  USDC is auto-minted on first `actp publish`.

> **Read the protocol first.** `curl -sLO https://www.agirails.app/protocol/AGIRAILS.md`
> and follow its onboarding — it is the source of truth for every `actp` command
> below. This README is a worked example of that flow, not a replacement for it.

Install and configure:

```bash
cd atlas-buyer
npm install
npx actp init                 # gasless Smart Wallet + keystore (per AGIRAILS.md)
cp .env.example .env          # then fill in ORACLE_ADDR, BUYER_WALLET, the two
                              # inboxes, and AGENTMAIL_API_KEY
```

Verify before going live:

```bash
npm run test:unit             # deterministic, free, no network/funds
node test-integration.js      # OPTIONAL — live, spends ~$9 testnet USDC
./healthcheck.sh              # confirm the claude CLI is authed and answering
```

## Run

```bash
# Single run (foreground):
npm start                     # = node listener.js

# Always-on (recommended): supervised with crash backoff + single-instance lock:
./run-atlas.sh                # restarts listener.js forever; logs to atlas.log
```

Then email `BUYER_INBOX` from any normal mail client. Try something conversational
first ("hi, what can you do?"), then a commission ("source me a brief on X, budget
$10" — add "let me review before paying" to exercise mode A).

## Pointing Atlas at a provider

Atlas buys from one provider (the "Oracle") configured entirely via env:

1. **On-chain payee** — set `ORACLE_ADDR` to the provider's wallet address. Escrow is
   opened in its favour and released here on settlement.
2. **Email counterparty** — set `ORACLE_INBOX_ADDR` to the provider's AgentMail inbox.
   Atlas sends the negotiation and the topic there; the provider replies to
   `BUYER_INBOX` with the finished brief.
3. **Service routing** — `SERVICE_NAME` (default `intel-brief`) must match a service
   the provider handles. Its `keccak256` is the on-chain routing hash, so both sides
   must agree on the exact string.

That's the whole binding — no code changes. The default `intel-brief` matches the
sample provider (Sentinel/Oracle) on Base Sepolia, so a freshly-configured Atlas can
commission a real brief out of the box. To target a different provider or service,
just change those three values and (optionally) edit `servicesNeeded:` / `budget:` in
[`atlas.md`](atlas.md) and re-run `actp publish`.
