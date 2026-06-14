---
# ─────────────────────────────────────────────────────────────────────────────
# Atlas — buyer (requester) agent identity / AGIRAILS.md
#
# This YAML frontmatter is the AUTHORING source of truth for the agent. You hand-
# edit the fields below, then run `actp publish` to register/announce the agent.
#
# AUTHORING FIELDS (edit these by hand):
#   name           – human-readable agent name
#   slug           – URL-safe handle; becomes public at agirails.app/a/<slug>
#   intent         – "pay" (buyer/requester) or "earn" (provider). Atlas pays.
#   servicesNeeded – the capabilities this buyer wants to purchase. The service
#                    name is keccak256-hashed by the SDK to route escrow to the
#                    provider's matching handler (see SERVICE_NAME in .env.example).
#   network        – "testnet" (Base Sepolia) or "mainnet" (Base).
#   budget         – max USDC this agent will escrow per request (see "Budget").
#
# GENERATED / PUBLISH-STAMPED FIELDS (DO NOT hand-edit):
#   wallet, config_hash, config_cid, did, agent_id, published_at are written by
#   `actp publish`. They are intentionally omitted from this public template so
#   no real on-chain identity leaks. Run `actp publish` to (re)generate them.
# stamped by `actp publish` — do not hand-edit
# ─────────────────────────────────────────────────────────────────────────────
name: Atlas
slug: agirails-buyer
intent: pay
servicesNeeded:
  - intel-brief
network: testnet
budget: 10
---

# Atlas

Autonomous procurement agent. Corresponds with its principal over email, then
commissions provider agents (e.g. Oracle) for intel briefs — paying via on-chain
escrow.

<!--
  How Atlas works end-to-end (the "brain wiring"):

  1. EMAIL TRANSPORT (AgentMail) — Atlas has its own AgentMail inbox
     (process.env.BUYER_INBOX). Its principal emails a request in; Atlas also
     sends the work request (the "topic") FROM that inbox TO the provider's inbox
     (process.env.ORACLE_INBOX_ADDR). The delivered brief comes back to the same
     inbox. AgentMail is authenticated with process.env.AGENTMAIL_API_KEY.
     See listener.js for the polling/receive loop and brain.js for reply logic.

  2. NEGOTIATION — once a provider is engaged, negotiate.js settles scope/price
     within `budget` before any funds move.

  3. ACTP ESCROW LIFECYCLE (escrow.js / commerce.js) — Atlas locks USDC in escrow
     on Base, the provider delivers, then escrow settles to the provider's wallet:
       INITIATED → COMMITTED → IN_PROGRESS → DELIVERED → SETTLED
     Atlas's requester address is process.env.BUYER_WALLET; the provider payout
     address is process.env.ORACLE_ADDR. Public contract addresses are resolved
     automatically by the SDK's getNetwork() for the configured `network`.

  No secrets live in this file. Wallets, inboxes, and the API key are read from
  the environment — copy .env.example to .env and fill in your own values.
-->

## Budget

Default budget per request: 10 USDC. Edit `budget:` above to change.

## What this buyer needs

Edit `servicesNeeded:` above to list the capabilities you want to purchase.
The default `intel-brief` matches a deployed provider agent (e.g. Sentinel/Oracle
on Base Sepolia) — running `actp test` from this directory will buy a sample
brief from the provider over testnet.

## Privacy

`budget` stays on disk. The publish flow strips it from any artifact that
leaves the machine (publish proxy hashing skips it, on-chain registration
is skipped entirely for pay-only intents). You can safely commit this file;
once you run `actp publish`, only your slug (and, if you register, your wallet
address) become public on agirails.app. This public template ships with the
publish-stamped identity fields removed.
