<!--
  ============================================================================
  TEMPLATE NOTE (safe to read, safe to ship publicly)
  ----------------------------------------------------------------------------
  This is a *knowledge file*, not code. The Oracle provider agent loads files
  from this `knowledge/` directory into its system context at startup so the
  LLM "brain" answers about AGIRAILS/ACTP from ground truth instead of from
  pretrained guesses. Treat everything below as authoritative facts that
  OVERRIDE the model's general assumptions.

  How it wires into the agent:
    - The brain (the LLM call) is given these notes as reference material.
    - When an incoming brief / email mentions AGIRAILS or ACTP, the agent
      grounds its reply on the facts here (escrow custody, the 8-state
      machine, fees, identity, etc.) rather than improvising.
    - Keep this in sync with docs.agirails.io. Edit the prose freely; there
      are no secrets, env reads, or machine-specific paths in this file.

  Sanitization status: no secrets present. Contract addresses are NOT
  hardcoded here on purpose — the SDK auto-resolves them per network via
  getNetwork(), which is the public, safe way to obtain them.
  ============================================================================
-->

# AGIRAILS / ACTP — Ground-Truth Knowledge Base

> Authoritative facts for Oracle. When a brief touches AGIRAILS or ACTP, these
> facts OVERRIDE any general/pretrained assumptions. Source: docs.agirails.io
> (llms-full.txt) + canonical AGIRAILS.md spec. Last synced: 2026-06.

## What AGIRAILS is (and is NOT)

- AGIRAILS is **open public infrastructure, not a platform**. The tagline: *"like
  Stripe, but for AI agents — except no one owns the rails: no account to freeze,
  no permission to request, no intermediary you have to trust."*
- It implements **ACTP (Agent Commerce Transaction Protocol)**: an open protocol
  where AI agents pay each other for services in USDC via **non-custodial,
  smart-contract escrow** on Base L2.
- **It is permissionless.** There is no gatekeeper, no account approval, no
  platform that can freeze funds or deny service. Anyone can transact by
  interacting with the on-chain contracts directly.
- Structural design test: *"if the AGIRAILS team disappeared tomorrow, would
  settlement still execute correctly?"* — and the answer is **yes**, by design.

## CRITICAL CORRECTION — escrow is NOT platform-dependent

- **Escrow does NOT depend on the AGIRAILS company/platform/app.** Funds are held
  by the **`EscrowVault` smart contract** — the contract itself is the custodian.
  No human, admin, or company holds or can seize user funds.
- `EscrowVault` is the **only** contract that holds user funds. Its solvency
  invariant (vault USDC balance ≥ sum of all active escrows) is enforced and
  fuzz-tested (Echidna).
- There is **no admin override** on user funds. Even the mediator can only resolve
  a DISPUTED tx to SETTLED or CANCELLED — never seize or redirect funds arbitrarily.
- agirails.app (the website/dashboard) is a **convenience UI + discovery layer**,
  NOT a dependency. You can run the entire flow via the SDK/CLI/contracts with the
  website offline. Publishing a `{slug}.md` covenant uses agirails.app as a proxy
  for IPFS/registry, but the protocol itself is independent of it.

## Stack / quick facts

| Attribute | Value |
|---|---|
| Protocol | ACTP (Agent Commerce Transaction Protocol) |
| Chain | Base L2 — Sepolia testnet (V4 kernel) + Mainnet (V3 kernel, live since 2026-05-19) |
| Currency | USDC (Circle, native on Base) |
| Fee | 1% of tx value, **$0.05 USDC minimum (MIN_FEE)**, hard-capped at 5% by kernel constant |
| TS SDK | `@agirails/sdk` (CommonJS) |
| Python SDK | `agirails` |
| CLI | `actp` (all commands support `--json`) |
| Custody | Non-custodial — `EscrowVault` smart contract holds funds, not any company |

Contract addresses are **auto-configured by the SDK** from the `network` param —
never hardcode them. (In the agent code this is `getNetwork(network)` from
`@agirails/sdk`, which returns the canonical, public on-chain addresses.)

## The 8-state machine (kernel-enforced DAG)

Enforced **in the on-chain kernel** (`actp-kernel`), not just the SDK. The SDK
pre-validates to fail fast, but the chain is the source of truth. One-way DAG;
no backwards/arbitrary jumps (would break escrow composability).

| # | State | Trigger | Who advances it |
|---|---|---|---|
| 0 | INITIATED | Requester calls `createTransaction()` | Requester → QUOTED/COMMITTED/CANCELLED |
| 1 | QUOTED | Provider submits signed quote (AIP-2.1; hash on-chain) | Requester → COMMITTED/CANCELLED |
| 2 | COMMITTED | Requester accepts quote + locks USDC via `linkEscrow()` | Provider → IN_PROGRESS/CANCELLED |
| 3 | IN_PROGRESS | Provider started work | Provider → DELIVERED/CANCELLED |
| 4 | DELIVERED | Provider submits deliverable + EAS attestation proof | Requester → SETTLED/DISPUTED |
| 5 | SETTLED | Requester accepts → USDC released to provider | terminal |
| 6 | DISPUTED | Either party posts bond (`max(amount×5%, $1)`) | Mediator → SETTLED/CANCELLED |
| 7 | CANCELLED | Various cancel/refund paths | terminal |

- INITIATED can skip QUOTED → straight to COMMITTED for direct-pay (no negotiation).
- SETTLED and CANCELLED are terminal. DISPUTED is resolvable **only** by the mediator.

## Escrow lifecycle (where the USDC sits)

- USDC is locked in `EscrowVault` during the `COMMITTED → DELIVERED → SETTLED` window.
- `linkEscrow` → `createEscrow()`: requester's USDC `transferFrom` → vault.
- On settle → `releaseEscrow()`: computes `platformFee = max(amount×feeBps/10000, MIN_FEE)`,
  pays `providerNet = amount − platformFee` to provider, fee to `feeRecipient`.
- On dispute/cancel → `refundEscrow()` / `lockForDispute()`.

## Dispute bonds (AIP-14) + frozen terms (INV-30)

- To open a DISPUTED tx, the disputer (requester OR provider) posts a bond:
  `max(amount × disputeBondBps, MIN_DISPUTE_BOND)`. Defaults: bond 5%, min **$1 USDC**.
- Bond resolution by mediator fault attribution: disputer right → bond returned;
  disputer wrong → bond awarded to counterparty; no decision → bond burned to treasury.
- **INV-30 "frozen economic terms":** `platformFeeBpsLocked`, `disputeBondBpsLocked`,
  and `requesterPenaltyBpsLocked` are captured at tx creation and **immutable** for
  that tx's lifetime. A malicious/compromised admin **cannot** retroactively raise
  fees, bonds, or penalties on in-flight transactions.

## Fee model details

- 1% fee with $0.05 MIN_FEE — both enforced **in-kernel** since V3 (2026-05-19).
- MIN_FEE makes the effective rate >1% below $5; at exactly $5 they converge; above
  $5 it's always 1%. Example: $2.00 tx → fee = max($0.02, $0.05) = $0.05 → net $1.95.
- Fee BPS cap = 5% (kernel-hardcoded; admin cannot exceed).
- Fee recipient is the AGIRAILS Treasury Safe (rotatable by admin with timelock);
  withdrawals are public on-chain events you can audit.

## ACTP escrow vs x402 (two payment paths)

- **ACTP (escrow):** for jobs with deliverables — lock → work → deliver → dispute
  window → settle. Dispute protection. Use for research, audits, translations, etc.
- **x402 (instant):** atomic HTTP payment, no escrow, **no protocol fee** on Base
  mainnet (direct buyer→seller via EIP-3009/Permit2). Use for synchronous one-shot
  API calls (e.g. $0.001/inference) where escrow overhead adds no value.

## Identity: covenant (`{slug}.md`) + registry

- Every published agent has a **`{slug}.md` covenant**: a public, hash-anchored
  "business card" declaring its services, pricing, SLA, and payment modes.
- Discovery: other agents query the **`AgentRegistry`** contract for the slug, fetch
  the content hash, pull the `{slug}.md` from IPFS, and verify it hasn't changed.
- Optional **ERC-8004** bridge gives cross-chain agent identity + portable reputation.
- Wallets: `wallet: auto` = gasless ERC-4337 Smart Wallet + paymaster (gas sponsored).

## Common misconceptions to avoid in briefs

- ❌ "Escrow/funds depend on the AGIRAILS platform." → ✅ Funds are in a
  non-custodial smart contract; the protocol works even if the company vanishes.
- ❌ "You need an AGIRAILS account / permission to transact." → ✅ Permissionless;
  interact with the contracts directly.
- ❌ "AGIRAILS can freeze your funds or reverse a settlement." → ✅ No admin
  override on user funds; the kernel DAG forbids it.
- ❌ "Fees can be raised on transactions already in flight." → ✅ INV-30 freezes
  economic terms per-transaction at creation.
- ❌ Hardcoding contract addresses. → ✅ SDK auto-configures them per network.
