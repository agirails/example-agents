// ─────────────────────────────────────────────────────────────────────────────
// Oracle (provider) — off-chain price negotiation responder
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT THIS DOES
// The Oracle agent answers the buyer's plain-text `[ACTP-NEGOTIATE]` handshake
// over AgentMail (email), BEFORE any on-chain escrow is created. Think of this as
// haggling over the price in email, then the agreed number becomes the amount the
// buyer escrows on-chain.
//
// WHY IT'S OFF-CHAIN
// Negotiation is cheap chatter — there is no reason to pay gas or open escrow just
// to agree on a number. Once both sides agree, the buyer calls `actp request`
// which escrows the agreed USD amount on Base L2. The ACTP escrow lifecycle
// (INITIATED → COMMITTED → IN_PROGRESS → DELIVERED → SETTLED) is completely
// untouched by this file — we only broker the price that gets escrowed. Settlement
// integrity, deadlines, and dispute paths are unchanged.
//
// THE STRATEGY
// Oracle quotes from its identity price band: floor $8 (will never go below),
// base $10 (its opening ask), ceiling $12 (max it would ever ask). It concedes
// downward over rounds — and crucially it rounds asks DOWN while the buyer rounds
// up — so the two sides deterministically converge instead of oscillating.
//
// THE WIRE PROTOCOL (plain text in email subject + body)
//   buyer → Oracle   Subject: [ACTP-NEGOTIATE] <corrId>
//                    Body:    QUOTE-REQUEST | COUNTER     OFFER: <usd>
//   Oracle → buyer   Subject: Re: [ACTP-NEGOTIATE] <corrId>
//                    Body:    COUNTER  ASK: <usd>   |   ACCEPT  PRICE: <usd>
// The `<corrId>` (correlation id) lives in the subject line and ties a multi-round
// negotiation together so Oracle can remember its current ask per conversation.

// AgentMail is the email transport. The Oracle agent has its own inbox address and
// talks to buyers purely through email — no webhooks, no extra infra. We poll the
// inbox on an interval and reply to new negotiation messages.
const { AgentMailClient } = require('agentmail');

// Tiny await-able delay used between inbox polls.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalize a sender field to a bare lowercase email address. AgentMail `from`
// values can look like `"Atlas" <atlas@agentmail.to>` — we pull out what's inside
// the angle brackets, or fall back to the raw string if there are none.
const emailOf = (from) => {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
};

// Parse the buyer's negotiation message body into a structured offer.
//   - Strips AgentMail's trailing "Sent via AgentMail" signature so it doesn't
//     pollute our regex matches.
//   - `num(label)` pulls a dollar figure for a labelled field (e.g. "OFFER: $9.50").
//   - `accept` is true if the buyer's message contains the word ACCEPT anywhere.
//   - `topic` is the optional service topic the buyer wants (free text).
function parseOffer(rawBody) {
  const body = String(rawBody || '').replace(/\n--\nSent via AgentMail[\s\S]*$/i, '');
  const num = (label) => {
    const m = body.match(new RegExp(label + '\\s*:\\s*\\$?\\s*([0-9]+(?:\\.[0-9]+)?)', 'i'));
    return m ? Number(m[1]) : null;
  };
  const accept = /\bACCEPT\b/i.test(body);
  return { accept, offer: num('OFFER'), price: num('PRICE'), topic: (body.match(/TOPIC:\s*(.+)/i) || [])[1] };
}

/**
 * Decide Oracle's response to a buyer offer, given the current ask.
 *
 * Pure function (no I/O) so it is trivially testable — see the exports at the
 * bottom. Returns one of:
 *   { done: false, ask }                         → counter with a new (lower) ask
 *   { done: true, accept: true, price }          → accept and lock in a price
 *
 * Convergence rule: Oracle rounds asks DOWN (Math.floor on the midpoint) while the
 * buyer is expected to round its offers UP. Because the two sides move toward each
 * other from opposite directions and meet in the middle, the back-and-forth always
 * terminates instead of bouncing forever.
 */
function evaluate(offer, currentAsk, { floor, base }) {
  // First round of a conversation has no remembered ask yet → open at `base`.
  const ask = currentAsk == null ? base : currentAsk;
  if (offer == null) return { done: false, ask };                              // no number from buyer → re-quote current ask
  if (offer >= ask) return { done: true, accept: true, price: ask };           // buyer met or beat our ask → take it
  if (offer >= floor && ask - offer <= 1) return { done: true, accept: true, price: Math.max(offer, floor) }; // within $1 and above floor → just meet them
  if (offer >= floor) {
    // Buyer is above our floor but still below our ask → concede halfway,
    // rounding DOWN, but never below the floor or below the buyer's own offer.
    const newAsk = Math.max(floor, Math.max(offer, Math.floor((ask + offer) / 2)));
    if (newAsk <= offer) return { done: true, accept: true, price: Math.max(offer, floor) }; // nothing left to concede → accept
    return { done: false, ask: newAsk };
  }
  // Buyer's offer is BELOW our floor — we cannot go there. Hold the line at the floor.
  if (ask <= floor) return { done: true, accept: true, price: floor }; // already sitting at the floor → accept at floor
  return { done: false, ask: floor };                                  // drop our ask straight to the floor and counter
}

/**
 * Start polling Oracle's inbox for negotiation messages and answer them.
 *
 * @param {object}  opts
 * @param {object}  opts.price   - Oracle's price band `{ floor, base, ceiling }` (USD).
 * @param {string}  opts.inboxId - Oracle's own AgentMail inbox address.
 * @param {string}  opts.apiKey  - AgentMail API key.
 * @param {number} [opts.pollMs] - Inbox poll interval in ms (default 6000).
 * @returns {() => void} stop()  - Call to halt the poll loop.
 */
function startNegotiator({ price, inboxId, apiKey, pollMs = 6000 } = {}) {
  // Credentials and inbox come from the environment so nothing is hardcoded.
  //   AGENTMAIL_API_KEY → authenticates this process to AgentMail (keep secret).
  //   ORACLE_INBOX      → Oracle's own AgentMail inbox address (e.g. your-provider-inbox@agentmail.to).
  // See .env.example for the placeholders to fill in.
  apiKey = apiKey || process.env.AGENTMAIL_API_KEY;
  inboxId = inboxId || process.env.ORACLE_INBOX || 'your-provider-inbox@agentmail.to';
  // Without an API key we can't talk to AgentMail — disable gracefully instead of
  // crashing, and hand back a no-op stop() so callers don't have to special-case it.
  if (!apiKey) { console.warn('[Oracle] negotiator: no AGENTMAIL_API_KEY — disabled'); return () => {}; }

  const client = new AgentMailClient({ apiKey });
  const answered = new Set();        // messageIds we've already responded to (dedupe across polls)
  const askByCorr = new Map();       // corrId -> our current ask (remembers state across rounds)
  let stopped = false;

  (async () => {
    // Prime the dedupe set: mark everything already sitting in the inbox at startup
    // as "answered" so we ONLY react to genuinely NEW negotiation messages that
    // arrive after we start. Without this we'd re-answer stale mail on every boot.
    const seed = await client.inboxes.messages.list(inboxId, { limit: 30 }).catch(() => null);
    for (const m of seed?.messages || []) answered.add(m.messageId || m.message_id);

    while (!stopped) {
      try {
        // Pull the latest messages, keep only ACTP negotiation mail we haven't
        // answered yet, and process oldest-first so multi-round threads advance
        // in the right order.
        const list = await client.inboxes.messages.list(inboxId, { limit: 15 }).catch(() => null);
        const msgs = (list?.messages || [])
          .filter((m) => (m.subject || '').includes('[ACTP-NEGOTIATE]'))
          .filter((m) => !answered.has(m.messageId || m.message_id))
          .reverse(); // oldest first

        for (const m of msgs) {
          const id = m.messageId || m.message_id;
          answered.add(id); // mark immediately so a slow reply can't cause a double-answer
          // Recover the correlation id from the subject; fall back to the whole subject.
          const corrId = ((m.subject || '').match(/\[ACTP-NEGOTIATE\]\s*(\S+)/) || [])[1] || (m.subject || '');
          const from = emailOf(m.from);
          if (!from || from === inboxId) continue; // ignore mail with no sender / our own echoes
          // Fetch the full message to read its body, then parse the buyer's offer.
          const full = await client.inboxes.messages.get(inboxId, id).catch(() => null);
          const p = parseOffer(full && full.text);

          // Buyer signalled ACCEPT → the deal is done off-chain. Forget our per-corr
          // ask state; the buyer will now escrow the agreed price via `actp request`.
          if (p.accept) { askByCorr.delete(corrId); console.log(`[Oracle] negotiation ${corrId} closed — buyer accepted $${p.price}`); continue; }

          // Otherwise run the pure decision function against our remembered ask.
          const decision = evaluate(p.offer, askByCorr.get(corrId), price);
          if (decision.done && decision.accept) {
            // We're accepting — clear state and reply ACCEPT with the locked price.
            askByCorr.delete(corrId);
            await client.inboxes.messages.send(inboxId, { to: [from], subject: `Re: [ACTP-NEGOTIATE] ${corrId}`, text: ['ACCEPT', `PRICE: ${decision.price}`].join('\n') }).catch(() => {});
            console.log(`[Oracle] negotiation ${corrId}: offer $${p.offer} → ACCEPT $${decision.price}`);
          } else {
            // Still haggling — remember our new ask for the next round and reply COUNTER.
            askByCorr.set(corrId, decision.ask);
            await client.inboxes.messages.send(inboxId, { to: [from], subject: `Re: [ACTP-NEGOTIATE] ${corrId}`, text: ['COUNTER', `ASK: ${decision.ask}`].join('\n') }).catch(() => {});
            console.log(`[Oracle] negotiation ${corrId}: offer $${p.offer == null ? '?' : p.offer} → COUNTER ask $${decision.ask}`);
          }
        }
      } catch (e) { /* never crash the poller — a bad message or a transient AgentMail error must not kill the loop */ }
      await sleep(pollMs);
    }
  })();

  // Caller uses this to cleanly shut the negotiator down (e.g. on process exit).
  return () => { stopped = true; };
}

module.exports = { startNegotiator, evaluate, parseOffer };
