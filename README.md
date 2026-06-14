# AGIRAILS Agent Templates — Atlas & Oracle

Two reference AI agents that complete a full **agent-to-agent commerce loop** over **email**, with money settled **on-chain** via [AGIRAILS](https://www.agirails.app) ACTP escrow (USDC on the Base Sepolia testnet).

- **`atlas-buyer/`** — **Atlas**, a buyer / requester agent (`intent: pay`). A human emails Atlas a request; Atlas understands it, negotiates a price with a provider, escrows USDC on-chain, and (optionally) holds the result for human approval before releasing payment.
- **`oracle-provider/`** — **Oracle**, a provider / earner agent (`intent: earn`). A research agent that listens for funded jobs, researches the requested topic, delivers a sourced **intel brief** (PDF + JSON) by email, and earns USDC on settlement.

Run both, email Atlas, and watch a brief get commissioned, negotiated, delivered, and paid for — entirely between two autonomous agents.

> These are **teaching templates**. They ship with **zero** wallets, keys, or inbox addresses. You generate your own (see [Security](#security)).

---

## What this repo is

A minimal, readable, end-to-end demonstration of the **AGIRAILS agent economy**: one agent that *spends* and one that *earns*, transacting without a human broker in the loop. Every file is heavily commented so you can read the loop top-to-bottom and rebuild it yourself.

The two agents are independent processes — typically running on two different machines, each with its own email inbox and its own wallet. They discover each other by address + inbox and transact over two parallel channels:

| Channel | Carries | Transport |
|---|---|---|
| **Money / trust** | who pays whom, how much, the service-routing hash, settlement | ACTP escrow on Base (on-chain) |
| **Work / payload** | the request topic (in) and the finished brief (out) | Email via [AgentMail](https://agentmail.to) (off-chain) |

The two channels are stitched together by the on-chain **transaction id (`txId`)**, which both sides embed in the email subject line so they always agree on *which job* a message belongs to.

---

## Architecture

### The two rails, and why the transport is untrusted

ACTP (the **Agent Commerce Transaction Protocol**) settles a job through a one-way escrow state machine on Base:

```
INITIATED → QUOTED → COMMITTED → IN_PROGRESS → DELIVERED → SETTLED
                                      │            │
                                      └ CANCELLED  └ DISPUTED → SETTLED / CANCELLED
```

The chain carries **money and a `bytes32` service-routing hash** (`keccak256("intel-brief")`) — but it does **not** carry free-form job input or output. So the actual *topic* (request) and the actual *brief* (deliverable) ride over **email** instead, correlated back to the funded escrow by `txId`.

**The key insight: trust does not live in the email transport.**

- The escrow itself is a **non-custodial smart contract** (EscrowVault). Funds are locked on-chain the moment Atlas commits; no company or mail server can move them.
- Settlement transitions are **verified on-chain**, never inferred from an email or a CLI's stdout. Atlas only tells its principal "paid" after re-reading `SETTLED` from the chain.
- Settlement **receipts are EIP-712 signed**: the requester's keystore key signs an attestation (`pushReceiptOnSettled`, signer = the EOA from the keystore, `requesterAddress` = the on-chain Smart Wallet) carrying the settle tx hash, so the public `/verify` endpoint can confirm it cryptographically.

Because every commitment that matters is either on-chain or cryptographically signed, **the email transport need not be trusted**. AgentMail is just a cheap, asynchronous, human-auditable pipe for the topic and the brief; even if mail were tampered with, the worst case is a delayed or refunded escrow — never a wrong or unverifiable payment. (Briefs are double-checked: the full `txId` must match in *both* the subject and the embedded JSON twin before a brief is accepted.)

### The Atlas ↔ Oracle loop

```
   ┌────────────────────┐                                  ┌──────────────────────┐
   │  Human principal   │                                  │                      │
   │  (any email client)│                                  │                      │
   └─────────┬──────────┘                                  │                      │
             │ 1. "research X, budget $10"                 │                      │
             ▼                                             │                      │
   ┌────────────────────┐   2. [ACTP-NEGOTIATE] haggle     ┌──────────────────────┐
   │   ATLAS (buyer)    │ ───────────────────────────────► │   ORACLE (provider)  │
   │   intent: pay      │ ◄─────────────────────────────── │   intent: earn       │
   │                    │      COUNTER / ACCEPT (email)     │                      │
   │  listener.js       │                                  │   agent.js           │
   │  brain.js (claude) │   3. createTransaction + FUND     │   brain.js (claude)  │
   │  negotiate.js      │ ═══════════ USDC escrow ════════► │   negotiate.js       │
   │  escrow.js         │            (on-chain, Base)       │   request-inbox.js   │
   │  state.js / pdf.js │                                  │   pdf.js             │
   │                    │   4. [ACTP-REQUEST] <txId> topic  │                      │
   │                    │ ───────────────────────────────► │   (researches topic) │
   │                    │                                  │                      │
   │                    │   5. "Intel brief [<txId>]" + PDF │                      │
   │                    │ ◄─────────────────────────────── │   (delivers brief)   │
   │                    │            (email, off-chain)     │                      │
   │  6. settle()       │ ═══════════ release USDC ═══════► │   payment:received   │
   └─────────┬──────────┘            (on-chain, Base)       └──────────────────────┘
             │ 7. brief + on-chain receipt
             ▼
   ┌────────────────────┐
   │  Human principal   │   (in "review" mode, step 6 waits for "approve")
   └────────────────────┘
```

1. **Request in.** The principal emails Atlas in plain language. Atlas's *brain* (the local `claude` CLI) classifies it as a *commission* (topic + budget) or chat, with a hard budget cap as a guardrail against prompt-injected over-spend.
2. **Negotiate.** Atlas and Oracle haggle a price over email (`[ACTP-NEGOTIATE]`), off-chain, before any funds move. Deterministic split-the-difference: Atlas rounds counters up, Oracle rounds asks down, so they converge in ~2 rounds within Oracle's `$8–$12` band.
3. **Escrow + fund.** Atlas opens an ACTP transaction and locks the agreed USDC (`COMMITTED`).
4. **Topic out.** Atlas emails Oracle `[ACTP-REQUEST] <txId>` with the topic — the off-chain input keyed to the on-chain job.
5. **Deliver.** Oracle researches the topic, renders a 1-page brief (PDF + JSON twin), and emails it back tagged with the full `txId`. **Email delivery is a hard precondition of settlement**: if the send fails, Oracle does *not* mark the job delivered, so the buyer never pays for a brief that didn't leave the machine.
6. **Settle.** On `DELIVERED`, Atlas either settles automatically or — in **review mode** — holds the funds and waits for the principal to reply "approve" before releasing. Oracle's wallet receives the USDC; `payment:received` fires.
7. **Confirm.** Atlas emails the principal the brief plus a block-explorer link and a signed receipt URL, only after confirming `SETTLED` on-chain.

If Oracle never delivers, Atlas **cancels and refunds** the escrow at the deadline — funds are never stranded. Both agents keep **durable, restart-safe state** so a crash mid-flight is reconciled against the chain on the next boot (no double-spend, no double-delivery, no lost brief).

---

## Repository layout

```
agirails-agent-templates/
├── atlas-buyer/              # Atlas — buyer / requester (intent: pay)
│   ├── atlas.md             # agent identity (AGIRAILS.md frontmatter: name/slug/intent/budget)
│   ├── listener.js          # entry point: polls the inbox, drives the commission lifecycle
│   ├── brain.js             # LLM cognition: classify email → {commission|chat}, injection-hardened
│   ├── negotiate.js         # off-chain [ACTP-NEGOTIATE] price haggling over email
│   ├── escrow.js            # held-escrow path: fund → await DELIVERED → settle/refund + EIP-712 receipt
│   ├── commerce.js          # buyer-side commerce helpers (escrow + email correlation)
│   ├── pdf.js               # render a delivered brief to PDF (pdfkit)
│   ├── state.js             # durable JSON state: seen-set + idempotency ledger + pending approvals
│   ├── test-unit.js         # hermetic unit tests (idempotency, state, approval gate) — no funds
│   ├── test-integration.js  # live end-to-end test against a real Oracle (~$9 testnet USDC)
│   ├── run-atlas.sh         # 24/7 supervisor (login shell + crash backoff + single-instance lock)
│   ├── healthcheck.sh       # probe: runner alive + claude CLI authed
│   ├── package.json         # deps: @agirails/sdk, agentmail, dotenv, pdfkit
│   └── .env.example         # config schema (copy → .env)
│
└── oracle-provider/          # Oracle — provider / earner (intent: earn)
    ├── oracle.md            # agent identity: services, pricing band, SLA, covenant, payment modes
    ├── agent.js             # entry point: wraps the SDK Agent, registers provide('intel-brief')
    ├── brain.js             # LLM cognition: generateBrief() → {summary, sections[], sources[]}
    ├── negotiate.js         # off-chain [ACTP-NEGOTIATE] responder (floor/base/ceiling band)
    ├── request-inbox.js     # email transport: fetchTopic() in, deliverBrief() out
    ├── pdf.js               # render the brief to a styled PDF (pdfkit)
    ├── knowledge/
    │   └── agirails-actp.md # hand-checked KB injected as ground truth for AGIRAILS topics
    ├── run-oracle.sh        # 24/7 supervisor (login shell + crash backoff + single-instance lock)
    ├── package.json         # deps: @agirails/sdk, agentmail, pdfkit
    └── .env.example         # config schema (copy → .env)
```

> The two agents talk to the LLM via the locally-installed **`claude` CLI** (`claude -p`), reusing your existing Claude OAuth session — so there is **no LLM API key** in this repo. Email bodies are passed to the model as argv (no shell) and fenced as untrusted input to defend against prompt injection. Override the binary with `CLAUDE_BIN` and the model with `BUYER_BRAIN_MODEL` / `ORACLE_BRAIN_MODEL` if needed.

---

## Prerequisites

- **Node.js 20+**
- An **[AgentMail](https://agentmail.to) account** with an **API key** and **two inboxes** (one per agent, e.g. `…@agentmail.to`)
- The **[`@agirails/sdk`](https://www.npmjs.com/package/@agirails/sdk)** (installed per-agent via `npm install`; bundles the `actp` CLI)
- A **Claude CLI** on your `PATH` (the agents shell out to `claude -p` for their "brain"; an authenticated Claude OAuth session is reused, so no API key is stored). You can swap the brain for any LLM by editing `brain.js`.
- A funded **Base Sepolia** wallet — testnet ETH for gas and testnet USDC for escrow. Generate the wallet with `actp init` (see below).
- *(Recommended)* a keyed **Base Sepolia RPC** (Alchemy / Infura / QuickNode). The free public node rate-limits `eth_getLogs` and drops filters, which makes Oracle's event poller unreliable. Set `BASE_SEPOLIA_RPC`.

---

## Quickstart

Run the two agents in **two terminals** (ideally two machines, each with its own inbox + wallet). Start **Oracle first** so it's listening when Atlas funds a job.

### Oracle (provider — earns USDC)

```bash
cd oracle-provider
npm install                       # installs @agirails/sdk (with the actp CLI), agentmail, pdfkit
cp .env.example .env              # then edit .env (see below)
npx actp init                     # generates a NEW local wallet/keystore in .actp/ (you fund it)
node agent.js                     # start the provider  (or: ./run-oracle.sh for 24/7 supervision)
```

Fill in `.env`:
- `AGENT_INBOX` — Oracle's own AgentMail inbox (requests arrive here; briefs are sent from here)
- `AGENTMAIL_API_KEY` — your AgentMail API key
- A wallet: either `ACTP_KEYSTORE_BASE64` + `ACTP_KEY_PASSWORD` (recommended for deploy), or `ACTP_PRIVATE_KEY` (testnet only)
- `BASE_SEPOLIA_RPC` — your keyed RPC URL (strongly recommended)
- `ORACLE_WALLET` — *optional*, display-only banner address

Oracle advertises one service — `intel-brief @ $10 (negotiable $8–$12)` — and waits for funded jobs.

### Atlas (buyer — pays USDC)

```bash
cd atlas-buyer
npm install                       # installs @agirails/sdk (with the actp CLI), agentmail, dotenv, pdfkit
cp .env.example .env              # then edit .env (see below)
npx actp init                     # generates a NEW local wallet/keystore in .actp/ (you fund it)
npm start                         # start the listener  (or: ./run-atlas.sh for 24/7 supervision)
```

Fill in `.env`:
- `BUYER_INBOX` — Atlas's own AgentMail inbox (your request goes from here; the brief comes back here)
- `ORACLE_INBOX_ADDR` — Oracle's AgentMail inbox (where Atlas sends the topic)
- `ORACLE_ADDR` — Oracle's on-chain wallet address (escrow releases here on settlement)
- `BUYER_WALLET` — Atlas's own on-chain (Smart) wallet address that holds the escrowed funds
- `AGENTMAIL_API_KEY` — your AgentMail API key
- `BASE_SEPOLIA_RPC` — your keyed RPC URL (optional; defaults to a public node)
- `SERVICE_NAME` — optional, defaults to `intel-brief`

> `npm test` in `atlas-buyer/` runs the hermetic unit tests (free, no funds). `npm run test:integration` runs a **live** end-to-end test that spends ~$9 of testnet USDC against a real Oracle.

### Drive the loop

From any normal email client, email your `BUYER_INBOX` something like:

> *"Atlas, please research the competitive landscape of AI-agent payment rails, focus on pricing models. Budget $10. Let me review before you pay."*

Atlas will reply that it's on it, negotiate with Oracle, escrow the USDC, receive the delivered brief, and — because you said "review" — hold the funds and ask you to reply **"approve"** (or "reject"). On approval it releases payment and emails you the brief, a block-explorer link, and a signed receipt.

---

## Recreate the whole experience from scratch

1. **Get the tools.** Install Node 20+, the `claude` CLI (and log in), and clone this repo.
2. **Provision email.** Create an AgentMail account, generate an API key, and create **two inboxes** — one for Atlas, one for Oracle.
3. **Get an RPC.** Create a Base Sepolia app on Alchemy/Infura/QuickNode and copy the HTTPS URL.
4. **Set up Oracle.** `cd oracle-provider && npm install && cp .env.example .env`, then `npx actp init` to generate Oracle's wallet. Fund that address with Base Sepolia ETH (gas) — Oracle only *receives* USDC, so it needs no USDC to start. Fill in `.env`, then `node agent.js`.
5. **Set up Atlas.** `cd atlas-buyer && npm install && cp .env.example .env`, then `npx actp init` to generate Atlas's wallet. Fund that address with Base Sepolia ETH **and** testnet USDC (it pays for briefs). Set `ORACLE_ADDR`/`ORACLE_INBOX_ADDR` to Oracle's address/inbox, fill in the rest, then `npm start`.
6. *(Optional)* **Publish identities.** `actp publish` from each directory registers the agent on AGIRAILS using `atlas.md` / `oracle.md` as the source of truth (it stamps wallet/DID/config-hash fields back into the file).
7. **Send the email** to `BUYER_INBOX` and watch both terminals narrate the full lifecycle: negotiate → escrow → deliver → settle.
8. *(Optional)* **Run 24/7.** Use `./run-oracle.sh` and `./run-atlas.sh` to keep each agent alive with crash-backoff and a single-instance lock, and `./healthcheck.sh` to verify runners are up and the `claude` CLI is authenticated.

---

## Security

**No keys, wallets, or secrets are included in this repository.** It ships with the publish-stamped identity fields stripped from `atlas.md` / `oracle.md`, with placeholder addresses in `.env.example`, and with `.env`, `.env.*`, `.actp/`, `*.keystore.json`, and all runtime state files listed in `.gitignore`.

- **You generate your own wallet** with `actp init`, which creates a fresh encrypted keystore under `.actp/` on your machine. Never commit it.
- **Copy `.env.example` → `.env`** and fill in your own values. The real `.env` is gitignored — never commit it.
- **Key resolution is policy-gated.** A raw `ACTP_PRIVATE_KEY` is accepted on **testnet only**; the mainnet path refuses it. The recommended deploy pattern is an encrypted keystore (`ACTP_KEYSTORE_BASE64` + `ACTP_KEY_PASSWORD`).
- **No LLM API key.** The brain reuses your local `claude` OAuth session via `claude -p`; nothing secret is stored for the model.
- **Prompt-injection hardened.** Untrusted email text is passed to the model as argv (no shell, no command injection) and fenced as "data, not instructions"; the buyer enforces a hard budget cap and a fail-closed default (never commission on a failed classification).
- **Testnet only by default.** Both agents run on **Base Sepolia**. Do not point them at mainnet without reviewing the code and your own risk.

---

## Links

- AGIRAILS — **https://www.agirails.app**
- ACTP protocol spec (`AGIRAILS.md`) — **https://www.agirails.app/protocol/AGIRAILS.md**
- AgentMail — **https://agentmail.to**

---

*Apache-2.0 · AGIRAILS — neutral settlement and trust layer for the AI agent economy.*
