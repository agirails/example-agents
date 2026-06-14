# Architecture — Atlas (buyer) ↔ Oracle (provider)

Two reference agents that complete one real agent-to-agent commerce transaction on
AGIRAILS:

- **`atlas-buyer/`** — the requester. A human emails Atlas; Atlas understands the
  request, negotiates a price, opens and funds an on-chain USDC escrow, receives the
  deliverable, and (autonomously, or after human "approve") releases payment.
- **`oracle-provider/`** — the provider. Oracle watches the chain for escrow opened
  against its `intel-brief` service, does the work (an LLM-researched brief), delivers
  it, and earns the escrowed USDC on settlement.

They are a buyer/seller pair, but the point of this doc is the *shape* of the system,
not the demo: **settlement is on-chain and fixed; transport is pluggable.**

> **Canonical reference.** This doc explains the *architecture*; the authoritative
> protocol definition, CLI, SDK surface, and onboarding flow live in one file:
> **https://www.agirails.app/protocol/AGIRAILS.md**. Both agents are built by
> following it — fetch and read it before wiring anything, and never reconstruct
> the protocol from this doc alone.

---

## The one idea: two rails, joined by `txId`

Every job runs over **two independent channels**:

| Rail | Carries | Where it lives | Trust model |
|------|---------|----------------|-------------|
| **Settlement** | money + trust: USDC escrow, the 8-state lifecycle, the service-routing hash, the delivery proof | **On-chain** (ACTP kernel + `EscrowVault` on Base L2) | Trustless. The contract is the custodian; no company holds or can seize funds. |
| **Transport** | the *content*: the work request (topic) going in, the deliverable (brief) coming back, negotiation messages | **Off-chain** (these demos use email / AgentMail) | Untrusted. The channel can lie, drop, or replay — it doesn't matter (see below). |

The chain deliberately **cannot** carry the job payload. On-chain, the service is only a
`bytes32` routing hash (`keccak256("intel-brief")`); the SDK has no on-chain field for
free-form input or output. So the actual topic and the finished brief ride the transport
rail, and the two rails are stitched together by the **on-chain transaction id (`txId`)** —
the single join key both sides agree on. In the demos, `txId` simply rides in the email
subject (`[ACTP-REQUEST] <txId>`).

```
        ┌──────────────────────── SETTLEMENT RAIL (on-chain, fixed) ────────────────────────┐
        │   ACTP kernel + EscrowVault on Base L2 — USDC custody, 8-state DAG, delivery proof │
        └───────────────▲───────────────────────────────────────────────────▲───────────────┘
                        │ open+fund escrow (txId)                            │ settle / dispute
                        │                                                    │
   ┌────────────┐   txId│                                              txId  │   ┌────────────┐
   │   ATLAS    │───────┴──────────  TRANSPORT RAIL (pluggable)  ──────┴─────────│  ORACLE    │
   │  (buyer)   │   request (topic) ───────────────────────────────────────►    │ (provider) │
   │            │   ◄─────────────────────────────────  deliverable (brief)     │            │
   └────────────┘        demos use EMAIL (AgentMail); could be anything         └────────────┘
```

---

## Why the transport can be untrusted

This is the load-bearing design property. The transport carries a **keyed, signed blob**,
not raw trust:

1. **The deliverable is EIP-712 signed by the provider.** ACTP's delivery proof
   (`DeliveryProofBuilder`, AIP-4 / AIP-16) is a typed-data signature over the
   delivery message, bound to the transaction. A forwarded, replayed, or
   man-in-the-middled message either verifies against the provider's address or it
   doesn't — the channel's honesty is irrelevant.

2. **It is bound to `(txId, signerAddress)`.** The signature commits to the specific
   `txId`, and an anti-replay nonce namespace prevents reuse. A blob lifted from one job
   cannot be passed off as another job's delivery; a look-alike from a stranger fails
   recovery.

3. **The content hash is anchored on-chain.** Settling to `DELIVERED` records an EAS
   attestation referencing the deliverable's hash (`resultHash` / `envelopeHash`). For
   private deliveries (AIP-16) the **plaintext never leaves the channel** — only the
   encrypted-envelope hash is anchored, so even a fully public transport leaks nothing.

Because verification lives at the protocol layer, the transport is reduced to *"can it
move a keyed blob from A to B, eventually?"* That is a very low bar — almost anything
clears it. The core SDK is kept strictly **transport-neutral**: it never imports a
channel, and email is explicitly "the first push channel, deliberately not privileged
over any other transport."

> Two trust layers, never conflated: a channel-level check (e.g. Svix HMAC) proves
> *"really from the transport, not replayed"*; the EIP-712 check proves *"a valid ACTP
> counterparty signed this."* A message that fails EIP-712 is rejected no matter what the
> channel says.

---

## The email loop (what the demos actually do)

```
  ATLAS (buyer)                         CHAIN (ACTP)                    ORACLE (provider)
       │                                     │                                │
   (1) │ ── negotiate price ───────────────────────────────── email ───────► │   off-chain handshake,
       │ ◄────────── counter / ACCEPT ──────────────────────────────────────  │   no funds moved yet
       │                                     │                                │
   (2) │ ── createTransaction + fund ──────► │  COMMITTED (USDC locked)       │
       │      (escrow opened → txId)         │                                │
       │                                     │   poller sees escrow ──────────►│  job dispatched
   (3) │ ── [ACTP-REQUEST] txId: TOPIC ───────────────────────── email ─────► │  correlate by txId
       │                                     │                                │
       │                                     │  IN_PROGRESS                   │  research the topic
   (4) │ ◄── "Intel brief [txId]" + JSON twin ──────────────── email ──────── │  deliver (HARD gate:
       │                                     │  DELIVERED (proof anchored) ◄───│  email must land first)
       │                                     │                                │
   (5) │ ── settle (auto, or after "approve") ─► SETTLED ──► USDC → Oracle    │  payment:received
       │                                     │                                │
```

1. **Request → Quote.** Atlas opens ~20% under budget; Oracle counters from its
   `$8–$12` band. They split the difference (Atlas rounds up, Oracle rounds down) and
   converge in a round or two. Pure off-chain haggling — no contract is touched. The
   agreed price becomes the escrow amount. (Price discovery is an application concern;
   keeping it off-chain is what keeps the protocol "single page".)
2. **Accept → Escrow.** Atlas funds the escrow on-chain; USDC is locked in `EscrowVault`
   (`COMMITTED`). This emits the `txId`.
3. **Request payload.** Atlas emails the actual topic, subject-tagged with the `txId`.
   Oracle's poller has already seen the escrow; it matches the email by `txId` and learns
   *what* to produce and *where* to reply.
4. **Deliver.** Oracle produces the brief and emails it back (human-readable prose + a
   machine-readable JSON twin), tagged with the full `txId`. **Delivery is a hard
   precondition of settlement**: if the email send fails, Oracle throws and the job is
   *not* marked `DELIVERED`, so escrow can never release for an undelivered brief.
5. **Settle.** Atlas verifies the brief belongs to this `txId`, then either settles
   automatically or holds at `DELIVERED` for a human "approve"/"reject" (held-escrow
   review mode). On settle the chain releases USDC to Oracle (minus the 1% / $0.05-min
   protocol fee); on no-show the escrow auto-refunds at its deadline.

Restart-safety on both sides comes from durable ledgers keyed by `txId` (Oracle never
re-pays for or re-emails a delivered brief; Atlas reconciles in-flight escrows against the
chain on boot) — which is exactly the resilience you need when the transport is async and
the process can die mid-flight.

---

## Swap the transport, keep the settlement

Email is just the demo binding. Anything that can move a keyed blob — and let each side
learn the other's reply address — can be the transport. The settlement rail does not
change.

| Transport | Correlation | Good for |
|-----------|-------------|----------|
| **Email / AgentMail** *(these demos)* | `txId` in subject | Human-auditable, async, zero infra; great for demos and human-in-the-loop review |
| **REST / webhooks** | `txId` in path/body; Svix-style HMAC for origin | Low-latency request/response between services |
| **Message queue (NATS / Kafka)** | `txId` as message key / subject | High-throughput, many concurrent jobs, durable replay |
| **WebSocket** | `txId` in frame | Live progress streaming, bidirectional sessions |
| **XMTP** | `txId` in message; wallet-native identity | Wallet-to-wallet, decentralized, no email infra |
| **A2A** | `txId` as task id | Interop with agent-to-agent protocol ecosystems |
| **AGIRAILS relay** | `txId` routing built in | Managed poll-based delivery with catch-up replay; no inbox/webhook to run |

The SDK already factors this out: channels are thin adapters over a reusable push
substrate (durable inbound store, one-webhook-to-many-subscription demux, client-side
`txId` + DID role routing), so a new transport is an adapter, not a rebuild.

---

## What is fixed vs. what is yours

**Fixed (the protocol — don't reinvent):**
- USDC escrow custody in `EscrowVault` (non-custodial; no admin override on funds).
- The 8-state DAG: `INITIATED → QUOTED → COMMITTED → IN_PROGRESS → DELIVERED → SETTLED`,
  with `DISPUTED` / `CANCELLED` branches. One-way, kernel-enforced.
- EIP-712 delivery proof + on-chain hash anchoring (this is what makes (1)–(3) above hold).
- Fee model: 1% with a $0.05 minimum, hard-capped at 5%, frozen per-transaction at creation.

**Yours (the application layer):**
- The transport (this is the whole point).
- Price discovery / negotiation logic.
- The service itself and how the deliverable is rendered.
- Whether to settle autonomously or gate on human approval.

If a feature can live on the application layer, it should — keep the protocol on a single
page.
