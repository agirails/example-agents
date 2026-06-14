// =============================================================================
// Atlas (buyer agent) — DETERMINISTIC UNIT TESTS
// =============================================================================
// These tests exercise Atlas's "bulletproofing" logic in complete isolation:
//   • NO network calls (no AgentMail polling, no RPC, no on-chain escrow)
//   • NO real funds at risk
//   • Fully deterministic — same input → same output, every run
//
// They cover the three things that MUST never break, because getting them wrong
// either double-pays a counterparty or pays for nothing:
//   1. Idempotency keys  — so a re-sent email never triggers a second payment.
//   2. State persistence  — so an in-flight escrow survives a process restart.
//   3. The approval gate  — so quoted email history can't be misread as consent,
//                           and so we filter out machine-to-machine ACTP mail.
//
// Run with:  node test-unit.js   (exits non-zero if any assertion fails — CI-friendly)
// =============================================================================

// ---------------------------------------------------------------------------
// Sandbox the state file BEFORE requiring ./state.
// state.js reads its persistence path from ATLAS_STATE_PATH at require-time, so
// we point it at a throwaway file in /tmp. This guarantees the unit tests can
// never read or clobber the live `.atlas-state.json` used by the running agent.
// ---------------------------------------------------------------------------
process.env.ATLAS_STATE_PATH = '/tmp/atlas-test-state.json';
require('node:fs').rmSync(process.env.ATLAS_STATE_PATH, { force: true }); // start from a clean slate

// ---------------------------------------------------------------------------
// Provider/Oracle inbox used by the isConversational filter test (see below).
// In production this is a *different* agent's AgentMail address. The only
// property the filter actually depends on is that it ends in "@agentmail.to"
// (machine-to-machine mail is never treated as a human conversation), so the
// specific local-part is incidental. Read it from the environment with a
// generic placeholder default — never hardcode a real inbox in a public repo.
// Set ORACLE_INBOX in your .env to point the test at your own counterparty.
// ---------------------------------------------------------------------------
const ORACLE_INBOX = process.env.ORACLE_INBOX || 'provider-agent@agentmail.to';

// ---------------------------------------------------------------------------
// Tiny test harness: count passes/fails and print a checkmark per assertion.
// `ok(name, cond)` is the only primitive — no framework dependency.
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// Modules under test (pure logic — both are require-safe with no side effects
// beyond reading/writing the sandboxed state file above).
const st = require('./state');
const { stripQuoted, isApproval, isReject, isConversational } = require('./listener');

// ===========================================================================
// 1) IDEMPOTENCY KEY
// ---------------------------------------------------------------------------
// st.idemKey(from, subject, body) produces a short, stable fingerprint of an
// inbound request. Atlas keys every committed transaction by this fingerprint
// so that if the SAME email arrives twice (retries, "did you get this?" nudges,
// duplicate webhook deliveries) it maps to the SAME key — and we skip paying
// a second time. The key MUST be insensitive to trivial differences (sender
// case, leading/trailing/collapsed whitespace) but sensitive to real content.
// ===========================================================================
console.log('=== idempotency key ===');
const k1 = st.idemKey('damir@x.io', 'Commission — x402 vs ACTP', 'please source a brief');
const k2 = st.idemKey('DAMIR@x.io', 'commission —  x402 vs ACTP ', 'Please source a brief'); // case/space variants of k1
const k3 = st.idemKey('damir@x.io', 'Commission — x402 vs ACTP', 'a totally different topic'); // same sender/subject, different ask
ok('identical resend → same key (case/space-insensitive)', k1 === k2); // dedup must survive cosmetic noise
ok('different content → different key', k1 !== k3);                     // genuinely new asks must NOT collide
ok('key is short + stable', typeof k1 === 'string' && k1.length === 16); // compact, fixed-width fingerprint

// ===========================================================================
// 2) STATE CRUD + DEDUP (the "committed" table)
// ---------------------------------------------------------------------------
// `committed` records track ACTP transactions Atlas has already acted on,
// keyed by the idempotency key. Two invariants matter:
//   • setCommitted MERGES into the existing record (never blows it away), so a
//     later state bump (PENDING → DELIVERED) preserves earlier fields.
//   • getCommitted on an unknown key returns null, not a throw — callers branch
//     on null to decide "new request vs. already-seen".
// ===========================================================================
console.log('=== state CRUD + dedup ===');
st.setCommitted(k1, { from: 'damir@x.io', topic: 'x402', amount: 9, state: 'PENDING' });
ok('committed stored', st.getCommitted(k1).state === 'PENDING');
// Second write only changes `state`; `topic` from the first write must survive (merge, not clobber):
ok('committed merges (not clobbers)', (st.setCommitted(k1, { state: 'DELIVERED' }), st.getCommitted(k1).topic === 'x402' && st.getCommitted(k1).state === 'DELIVERED'));
ok('unknown key → null', st.getCommitted('nope') === null);

// ===========================================================================
// 3) PENDING LIFECYCLE (one in-flight escrow per counterparty)
// ---------------------------------------------------------------------------
// While an ACTP escrow is open with a given counterparty, Atlas parks the
// txId / amount / human-readable ref in `pending`, keyed by the counterparty's
// email. This is what lets a later "approve"/"reject" reply find the matching
// escrow to release or cancel. clearPending() removes it once resolved.
// ===========================================================================
console.log('=== pending lifecycle ===');
st.setPending('damir@x.io', { txId: '0xabc', amount: 9, ref: 'ABC123' });
ok('pending stored', st.getPending('damir@x.io').txId === '0xabc');
st.clearPending('damir@x.io');
ok('pending cleared', st.getPending('damir@x.io') === null);

// ===========================================================================
// 4) SEEN-MESSAGE DEDUP
// ---------------------------------------------------------------------------
// AgentMail polling can re-deliver the same message id. markSeen/hasSeen give
// Atlas an at-most-once guarantee per message id so the same email is never
// processed twice within a run (complements the idempotency key, which guards
// across distinct messages with identical content).
// ===========================================================================
console.log('=== seen ===');
st.markSeen('msg-1');
ok('seen marked', st.hasSeen('msg-1') === true);
ok('unseen → false', st.hasSeen('msg-2') === false);

// ===========================================================================
// 5) PERSISTENCE ACROSS RESTART
// ---------------------------------------------------------------------------
// THE critical safety property: if the process crashes or is redeployed mid-
// escrow, the held funds and dedup history MUST still be there on reboot.
// We simulate a restart by evicting ./state from Node's module cache and
// re-requiring it — forcing a fresh load that re-reads the state file from disk.
// Everything written above (pending, committed, seen) must reappear.
// ===========================================================================
console.log('=== PERSISTENCE across restart (re-require fresh) ===');
st.setPending('damir@x.io', { txId: '0xHELD', amount: 9, ref: 'HELD01', topic: 't' });
delete require.cache[require.resolve('./state')]; // evict cached module → simulate process restart
const st2 = require('./state');                   // fresh instance re-reads /tmp/atlas-test-state.json
ok('pending survives restart', st2.getPending('damir@x.io') && st2.getPending('damir@x.io').txId === '0xHELD');
ok('committed survives restart', st2.getCommitted(k1) && st2.getCommitted(k1).state === 'DELIVERED');
ok('seen survives restart', st2.hasSeen('msg-1') === true);

// ===========================================================================
// 6) APPROVAL GATE (quoted-history & ambiguity safe)
// ---------------------------------------------------------------------------
// Atlas only releases escrow on an explicit human "approve" and only cancels on
// an explicit "reject". The danger: email clients quote the prior message, and
// Atlas's own outbound note often says things like "reply reject to withhold".
// If we scanned the WHOLE reply we'd find that quoted word and mis-fire.
//
// Defense: stripQuoted() removes quoted history (lines beginning with ">", and
// everything after an "On <date>, X wrote:" attribution) BEFORE isApproval /
// isReject run. The intent classifiers are also bilingual (EN + HR) to match
// how the operator actually replies.
// ===========================================================================
console.log('=== approval gate (quoted-history & ambiguity safe) ===');
ok('plain approve', isApproval(stripQuoted('approve')) && !isReject(stripQuoted('approve')));
ok('plain reject', isReject(stripQuoted('reject')) && !isApproval(stripQuoted('reject')));
// The reply says "approve" but the quoted history contains "reject" — must read as APPROVE only:
ok('approve ignores quoted reject history', (() => { const c = stripQuoted('approve please\n\nOn Mon, Atlas wrote:\n> reply reject to withhold'); return isApproval(c) && !isReject(c); })());
ok('quoted ">" lines stripped', !/reject/.test(stripQuoted('yes go ahead\n> or reject it')));
ok('Croatian approve', isApproval(stripQuoted('odobravam, pusti')));      // "I approve, release"
ok('Croatian reject', isReject(stripQuoted('nemoj plaćati, odbij')));     // "don't pay, reject"

// ===========================================================================
// 7) isConversational FILTER
// ---------------------------------------------------------------------------
// The inbox carries two kinds of mail:
//   • Human conversation (the operator commissioning work) — Atlas should engage.
//   • Machine-to-machine ACTP traffic (its own provider/Oracle, system mails,
//     structured "[ACTP-*]" requests, "Intel brief [0x..]" deliveries) — Atlas
//     must NOT treat these as a chat to reply to, or it would talk to itself.
//
// isConversational() returns true ONLY for human-shaped mail. Key rules tested:
//   • Any "@agentmail.to" sender → false (it's another agent / the system).
//   • Subjects tagged "[ACTP-...]" or containing an on-chain "[0x..]" ref → false.
// Note ORACLE_INBOX is env-driven (see top of file) so no real address is baked in.
// ===========================================================================
console.log('=== isConversational filter ===');
ok('external sender + normal subject → yes', isConversational({ from: 'damir@agirails.io', subject: 'Commission — brief' }));
ok('self/provider mail → no', !isConversational({ from: ORACLE_INBOX, subject: 'x' })); // any @agentmail.to → machine mail
ok('[ACTP-*] subject → no', !isConversational({ from: 'damir@agirails.io', subject: '[ACTP-REQUEST] 0x..' }));
ok('Intel brief subject → no', !isConversational({ from: 'damir@agirails.io', subject: 'Intel brief [0x..]' }));

// ---------------------------------------------------------------------------
// Summary + CI exit code: non-zero if anything failed, so `node test-unit.js`
// can gate a build/deploy.
// ---------------------------------------------------------------------------
console.log(`\n=== UNIT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
