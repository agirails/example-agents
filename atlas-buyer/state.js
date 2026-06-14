// =============================================================================
// Atlas (buyer agent) — durable state store
// =============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// Atlas is an email-driven *buyer*: a human emails it a request, Atlas turns
// that request into an ACTP escrow on Base L2, pays a provider agent, and emails
// the result back. All of that involves real money (USDC) and a multi-step,
// asynchronous lifecycle. The process can crash, be redeployed, or receive the
// exact same email twice (resends, retries, "did you get this?" follow-ups).
//
// This module is the small, boring, *critical* layer that makes those hazards
// safe. It persists three maps to a single JSON file on disk so that across
// restarts:
//
//   - a funded escrow is never orphaned (we remember every txId we opened),
//   - an inbound email is never processed twice (idempotency + a `seen` set),
//   - an identical resend never double-spends (same email -> same idemKey ->
//     same commission record, so we no-op instead of opening a 2nd escrow).
//
// THE THREE MAPS
// --------------
//   seen:      Array of messageIds we've already handled (capped at SEEN_CAP).
//              On restart we don't reprocess mail we already acted on. We prime
//              this with the inbox's existing messages at boot so historical
//              mail doesn't trigger a flood of new escrows.
//
//   committed: idemKey -> { txId, topic, amount, from, mode, state, createdAt }
//              The deterministic "one email == one escrow" ledger. The idemKey
//              is derived purely from the email's (from, subject, body), so the
//              same email always maps to the same record. This is what makes
//              resends safe: we look up the idemKey first; if it already has a
//              committed record, we reuse it instead of opening another escrow.
//
//   pending:   from -> { txId, topic, amount, durationMs, idemKey }
//              "mode-A" commissions that have been DELIVERED on-chain and are now
//              waiting for the human to approve or reject by replying to the
//              email. Keyed by sender so an "approve"/"reject" reply can find the
//              escrow it refers to. (mode-A = human-in-the-loop approval before
//              settlement; the alternative mode auto-settles.)
//
// HOW IT RELATES TO THE ACTP ESCROW LIFECYCLE
// -------------------------------------------
// ACTP transactions move through a one-way state machine:
//   INITIATED -> COMMITTED -> IN_PROGRESS -> DELIVERED -> SETTLED (or DISPUTED/CANCELLED)
// This file doesn't drive those transitions itself — the brain/runtime does, via
// the @agirails/sdk. What it stores is the *bookkeeping* around them: which txId
// belongs to which email (committed), and which DELIVERED escrows are blocked on
// a human reply (pending). When the human approves, the brain reads `pending`,
// settles the escrow, and clears the entry.
//
// DESIGN NOTE: deliberately dependency-free + synchronous
// -------------------------------------------------------
// We use a plain JSON file and synchronous fs calls on purpose. The state is
// tiny, writes are infrequent (only on real lifecycle events), and a sync write
// gives us a simple "the record is on disk before we proceed" guarantee without
// pulling in a database. For a single-tenant agent this is the right altitude.
// If you scale to many concurrent agents, swap this module for a real KV/DB —
// the public surface (module.exports below) is small enough to reimplement.
//
// NOTE FOR TEMPLATE USERS: this file contains NO secrets and NO logic specific
// to one deployment. The only configurable knob is ATLAS_STATE_PATH (env) — see
// below. Everything else is generic, reusable buyer-agent plumbing.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Where the durable state lives. Defaults to a dotfile next to this module so a
// fresh clone "just works". Override ATLAS_STATE_PATH in your environment if you
// run multiple agents from one checkout, or want state on a mounted volume so it
// survives container redeploys (recommended for production).
const STATE_PATH = process.env.ATLAS_STATE_PATH || path.join(__dirname, '.atlas-state.json');

// Cap on how many processed messageIds we retain. The `seen` set only needs to
// be large enough to cover the window of mail that could plausibly be re-fetched
// or resent; keeping it bounded stops the state file from growing forever.
const SEEN_CAP = 800;

// In-memory cache of the parsed state. Loaded lazily on first access and reused
// for the lifetime of the process — every getter/setter goes through load().
let _s = null;

// Read state from disk once and memoize it. If the file is missing or corrupt we
// fall back to an empty object (fresh start) rather than crashing — a buyer agent
// should always be able to boot. We then defensively normalize each map so the
// rest of the code can assume the shapes are present and well-typed.
function load() {
  if (_s) return _s;
  try { _s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { _s = {}; }
  _s.seen = Array.isArray(_s.seen) ? _s.seen : [];
  _s.committed = _s.committed && typeof _s.committed === 'object' ? _s.committed : {};
  _s.pending = _s.pending && typeof _s.pending === 'object' ? _s.pending : {};
  return _s;
}

// Persist the in-memory state back to disk. We trim `seen` to the cap on the way
// out (keeping the most recent entries via slice(-SEEN_CAP)). A failed write is
// logged but not thrown: losing one save is recoverable, but crashing the agent
// mid-flow is worse. (For stronger durability you could write-to-tmp + rename
// for atomicity — see the SDK's pendingPublish.ts for that pattern.)
function save() {
  const s = load();
  if (s.seen.length > SEEN_CAP) s.seen = s.seen.slice(-SEEN_CAP);
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
  catch (e) { console.error('[Atlas] state save failed:', e.message); }
}

// --- seen (processed messageIds) -------------------------------------------
// The first line of defense against reprocessing. AgentMail gives every message
// a stable messageId; once we've acted on one, we record it here so a restart or
// a re-poll of the inbox doesn't run the same commission again.
function hasSeen(id) { return load().seen.includes(id); }
function markSeen(id) { const s = load(); if (id && !s.seen.includes(id)) { s.seen.push(id); save(); } }
// primeSeen is called at boot with the messageIds already in the inbox. This
// "marks history as handled" so the agent doesn't wake up and treat every old
// email as a brand-new request. Note the single save() at the end (batch write).
function primeSeen(ids) { const s = load(); for (const id of ids) if (id && !s.seen.includes(id)) s.seen.push(id); save(); }

// --- idempotency: one inbound email == one commission ----------------------
// The second, stronger line of defense. Even if `seen` is bypassed (e.g. a true
// resend with a different messageId), the content-derived idemKey ensures the
// same email maps to the same escrow record.
//
// norm() canonicalizes a string so trivial differences (case, whitespace runs,
// leading/trailing spaces) don't produce a different key — important because
// mail clients love to re-flow whitespace.
const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
// idemKey hashes the normalized (from | subject | body) triple into a short,
// stable, deterministic key. Same email -> same 16-hex-char key -> same record.
// 16 hex chars (64 bits) is plenty of collision resistance for one agent's mail
// volume while keeping the JSON keys readable.
function idemKey(from, subject, body) {
  return crypto.createHash('sha256').update(`${norm(from)}|${norm(subject)}|${norm(body)}`).digest('hex').slice(0, 16);
}
// Look up / upsert the commission ledger. setCommitted merges fields so callers
// can update an existing record incrementally (e.g. add a txId now, flip `state`
// to DELIVERED later) without clobbering the rest of the record.
function getCommitted(key) { return load().committed[key] || null; }
function setCommitted(key, rec) { const s = load(); s.committed[key] = { ...(s.committed[key] || {}), ...rec }; save(); }

// --- pending mode-A approvals ----------------------------------------------
// Keyed by sender email address. When a mode-A escrow reaches DELIVERED, we park
// it here and email the human for a yes/no. Their reply (an "approve"/"reject")
// is looked up by `from`, settled or cancelled accordingly, then cleared.
// allPending()/allCommitted() expose the full maps as [key, value] entry arrays
// so the brain can sweep them (e.g. on boot, reconcile any in-flight escrows).
function getPending(from) { return load().pending[from] || null; }
function setPending(from, rec) { const s = load(); s.pending[from] = rec; save(); }
function clearPending(from) { const s = load(); delete s.pending[from]; save(); }
function allPending() { return Object.entries(load().pending); }
function allCommitted() { return Object.entries(load().committed); }

// Public surface. Intentionally small — this is the entire contract the brain
// depends on, so the storage backend can be swapped without touching callers.
module.exports = {
  STATE_PATH, idemKey,
  hasSeen, markSeen, primeSeen,
  getCommitted, setCommitted, allCommitted,
  getPending, setPending, clearPending, allPending,
};
