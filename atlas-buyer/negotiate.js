// Atlas's price negotiation — a plain-text agent↔agent handshake over AgentMail,
// run BEFORE the on-chain escrow. Atlas opens below the provider's list price and
// counters until they converge; the agreed price then drives `actp request`.
//
// WHERE THIS SITS IN THE ACTP LIFECYCLE
// -------------------------------------
// ACTP (the Agent Commerce Transaction Protocol) settles a job through an 8-state
// escrow machine: INITIATED → QUOTED → COMMITTED → IN_PROGRESS → DELIVERED →
// SETTLED (with CANCELLED / DISPUTED branches). That machine needs a *price* before
// any USDC is locked. This file produces that price. It is pure off-chain haggling:
// no funds move here, no contract is touched. The number it returns becomes the
// escrow amount when Atlas later calls the ACTP client to commission the work.
// Keeping negotiation off-chain keeps the protocol "single page" simple — price
// discovery is an application-layer concern, settlement is the protocol's concern.
//
// PROTOCOL (plain text, the email Subject carries the correlation id)
// ------------------------------------------------------------------
//   Atlas → Oracle  [ACTP-NEGOTIATE] <corrId>
//     QUOTE-REQUEST / COUNTER
//     SERVICE: intel-brief
//     TOPIC: <topic>
//     OFFER: <usd>
//   Oracle → Atlas  Re: [ACTP-NEGOTIATE] <corrId>
//     COUNTER  ASK: <usd>   |   ACCEPT  PRICE: <usd>
//
// Deterministic split-the-difference: Atlas rounds its counters UP, Oracle rounds
// its asks DOWN, so they meet in ~2 rounds. If Oracle stays silent, Atlas falls
// back to paying its full budget (so the flow still completes).

// `dotenv` loads the local `.env` into process.env. `quiet: true` suppresses the
// "tip" banner so it doesn't pollute agent logs. See `.env.example` for the schema.
require('dotenv').config({ quiet: true });

// AgentMail is the email transport for agent↔agent messaging. Each agent owns an
// inbox address (…@agentmail.to) and talks to the API with an API key. We use it as
// a cheap, asynchronous, human-auditable channel: every offer/counter is a real
// email you can read, which makes the negotiation transparent and debuggable.
const { AgentMailClient } = require('agentmail');

// --- Identity / addressing -------------------------------------------------------
// Both inboxes are read from the environment so this template carries NO real
// addresses. Provision two AgentMail inboxes (one for the buyer, one for the
// provider/Oracle) and set these in your `.env`. There is intentionally no
// hardcoded fallback: a missing inbox should fail loudly rather than silently mail
// some stranger's address.
const BUYER_INBOX = process.env.BUYER_INBOX;        // this agent's own AgentMail inbox
const ORACLE_INBOX = process.env.ORACLE_INBOX_ADDR; // the provider ("Oracle") we negotiate with
const MAX_ROUNDS = 4;                               // hard cap on back-and-forth rounds

// The AgentMail API key authenticates send/list/get calls. Secret — keep it in
// `.env`, never commit it.
const mail = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY });

// Tiny await-able delay, used to pace inbox polling below.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Email "From" headers come in many shapes: "Name <addr@host>", a bare address, or
// undefined. This normalizes any of them down to a lowercase bare address so we can
// reliably compare against ORACLE_INBOX when filtering replies.
const emailOf = (from) => {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
};

/** Parse Oracle's reply body → { accept, price?, ask? }.
 *  The body is free-ish text; we strip AgentMail's auto-appended signature first,
 *  then pull the first dollar figure following a labelled field (ACCEPT/PRICE/ASK).
 *  Tolerant of "$", whitespace, and decimals so a slightly-formatted reply still parses. */
function parseOracleReply(rawBody) {
  // Drop the "Sent via AgentMail …" footer so it never gets mistaken for content.
  const body = String(rawBody || '').replace(/\n--\nSent via AgentMail[\s\S]*$/i, '');
  // Helper: find the number after a given label, e.g. num('ASK') → 7.5.
  const num = (label) => {
    const m = body.match(new RegExp(label + '\\s*:\\s*\\$?\\s*([0-9]+(?:\\.[0-9]+)?)', 'i'));
    return m ? Number(m[1]) : null;
  };
  // An ACCEPT closes the deal. We prefer an explicit PRICE, else fall back to ASK.
  if (/\bACCEPT\b/i.test(body)) return { accept: true, price: num('PRICE') ?? num('ASK') };
  // Otherwise it's a counter-offer carrying the Oracle's current ASK.
  return { accept: false, ask: num('ASK') };
}

/** Send one negotiation message to the Oracle on this correlation id.
 *  The Subject is `[ACTP-NEGOTIATE] <corrId>` so both sides (and any reply thread)
 *  can group messages by the deal they belong to. `.catch(() => {})` swallows
 *  transient send errors — a dropped message just means we wait and retry the round. */
async function send(corrId, lines) {
  await mail.inboxes.messages
    .send(BUYER_INBOX, { to: [ORACLE_INBOX], subject: `[ACTP-NEGOTIATE] ${corrId}`, text: lines.join('\n') })
    .catch(() => {});
}

/** Wait for Oracle's next unseen reply on this corrId. Dedupes by messageId
 * (no reliance on list ordering / timestamps). Returns the parsed reply or null.
 *
 * HOW IT WORKS: AgentMail has no push/webhook here, so we poll the inbox every
 * `pollMs` until `timeoutMs`. We list the most recent messages, find the first one
 * that (a) we haven't already consumed, (b) carries this corrId in its subject, and
 * (c) actually came from the Oracle. The `seen` Set guards against re-processing the
 * same message across poll cycles — that's why dedup is by messageId, not by
 * position or arrival time (which list ordering can't be trusted to give us). */
async function waitOracleReply(corrId, seen, { timeoutMs = 70000, pollMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await mail.inboxes.messages.list(BUYER_INBOX, { limit: 15 }).catch(() => null);
    const hit = (list?.messages || []).find((m) => {
      // AgentMail responses may use camelCase or snake_case for the id; accept both.
      const id = m.messageId || m.message_id;
      return id && !seen.has(id) && (m.subject || '').includes(corrId) && emailOf(m.from) === ORACLE_INBOX;
    });
    if (hit) {
      const id = hit.messageId || hit.message_id;
      seen.add(id); // mark consumed so the next poll won't pick it up again
      // The list view may be a summary; fetch the full message to get the body text.
      const full = await mail.inboxes.messages.get(BUYER_INBOX, id).catch(() => null);
      return parseOracleReply(full && full.text);
    }
    await sleep(pollMs);
  }
  return null; // timed out — caller treats this as "Oracle silent"
}

/**
 * Negotiate a price for `topic`, never exceeding `maxBudget`.
 * Returns { price, rounds, summary, deal }.
 *   deal=true  → Oracle agreed; price ≤ maxBudget.
 *   deal=false → Oracle silent or wouldn't meet budget; price = maxBudget (fallback).
 *
 * `onState` is an optional progress callback so a calling brain/UI can narrate the
 * haggling live ("counter $8", "Oracle accepted $9", …) without this module knowing
 * anything about how it's surfaced.
 */
async function negotiate({ topic, maxBudget = 10, onState } = {}) {
  // Correlation id ties the whole thread together; base36 of the timestamp is short
  // and unique enough for one buyer's concurrent deals.
  const corrId = `neg-${Date.now().toString(36)}`;
  const log = (s) => onState && onState(s);

  let myOffer = Math.max(1, Math.ceil(maxBudget * 0.8)); // open ~20% under budget
  let round = 1;
  let price = null;
  const seen = new Set(); // Oracle reply messageIds already consumed

  // Open the negotiation with a QUOTE-REQUEST carrying our first offer.
  log(`open offer $${myOffer} (budget $${maxBudget})`);
  await send(corrId, ['QUOTE-REQUEST', 'SERVICE: intel-brief', `TOPIC: ${topic}`, `OFFER: ${myOffer}`, `ROUND: ${round}`]);

  while (round <= MAX_ROUNDS) {
    const r = await waitOracleReply(corrId, seen);
    if (!r) { log('no reply from Oracle — falling back to budget'); break; }

    // Oracle accepted outright. Use its stated price, or our last offer if absent.
    if (r.accept) { price = r.price != null ? r.price : myOffer; log(`Oracle accepted $${price}`); break; }

    const ask = r.ask;
    if (ask == null) { log('unparseable counter — falling back'); break; }
    log(`Oracle asks $${ask}`);

    // Close enough and affordable → accept at Oracle's ask. (Within $1 of our offer
    // and under budget: not worth another round-trip to split a dollar.)
    if (ask <= maxBudget && ask - myOffer <= 1) {
      price = ask;
      await send(corrId, ['ACCEPT', `PRICE: ${price}`]);
      log(`accepted $${price}`);
      break;
    }

    // Split the difference, rounding UP toward the Oracle's ask, but never above budget.
    const next = Math.min(maxBudget, Math.ceil((myOffer + ask) / 2));
    if (next <= myOffer) {
      // Can't improve our offer. Accept if Oracle's ask fits the budget, else give up.
      if (ask <= maxBudget) { price = ask; await send(corrId, ['ACCEPT', `PRICE: ${price}`]); log(`accepted $${price}`); }
      else log(`Oracle's $${ask} exceeds budget $${maxBudget} — no deal`);
      break;
    }

    // Send the improved counter and go another round.
    myOffer = next;
    round += 1;
    log(`counter $${myOffer}`);
    await send(corrId, ['COUNTER', `OFFER: ${myOffer}`, `ROUND: ${round}`]);
  }

  const deal = price != null;
  if (!deal) price = maxBudget; // fallback so the commission still proceeds
  // Human-readable one-liner the brain can drop straight into a status update.
  const summary = deal
    ? `Negotiated $${price} with Oracle (you budgeted $${maxBudget}) over ${round} round${round === 1 ? '' : 's'}.`
    : `Oracle didn't settle a price in time — proceeding at your $${maxBudget} budget.`;
  return { price, rounds: round, summary, deal };
}

module.exports = { negotiate };
