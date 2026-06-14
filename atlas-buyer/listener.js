// Atlas — buyer (requester) agent. A stable email listener that runs on its own
// AgentMail inbox. A human principal emails it (e.g. from Gmail); Atlas understands
// the request with an LLM "brain", negotiates a price with a provider agent, opens
// an on-chain USDC escrow via ACTP, and — in "review" mode (mode A) — holds the
// delivered brief for the principal's explicit approval before releasing payment.
//
// Reliability goals (why the code looks the way it does):
//   • Exactly-once: identical resends of the same email fund exactly ONE escrow.
//   • Durable: all in-flight state survives process restarts (see ./state).
//   • No stranded funds: a held escrow auto-refunds at its deadline, and a boot-time
//     reconciler resumes anything that was mid-flight when the process died.
//   • Confirmed-before-claimed: every settlement is verified on-chain before Atlas
//     tells the principal it's done.
//
// ── How the moving parts fit together ───────────────────────────────────────────
//   AgentMail   → email transport. We poll our inbox, read messages, and send replies
//                 (including JSON/PDF attachments) all through the AgentMailClient.
//   brain.js    → understand(): LLM that classifies an email as a "commission" (with a
//                 topic + budget) or ordinary chat, and detects review-vs-autonomous.
//   negotiate.js→ negotiate(): agrees a price with the provider (the "Oracle" agent).
//   escrow.js   → the ACTP lifecycle touchpoints: escrowHold() opens+funds the escrow
//                 and waits for delivery; settle() releases funds to the provider and
//                 confirms on-chain; txStatus()/fetchBrief() let the reconciler inspect
//                 an existing transaction after a restart.
//   pdf.js      → renderBriefPdf(): pretty-prints the delivered brief as a PDF.
//   state.js    → durable, restart-safe persistence (seen-set + commissions + pendings).

require('dotenv').config({ quiet: true });
const { AgentMailClient } = require('agentmail');
const { understand } = require('./brain');
const { negotiate } = require('./negotiate');
const { escrowHold, settle, txStatus, fetchBrief } = require('./escrow');
const { renderBriefPdf } = require('./pdf');
const st = require('./state');

// ── Configuration (all secrets/identity come from the environment) ───────────────
// BUYER_INBOX  — this agent's real AgentMail address (e.g. "you@agentmail.to").
//                Required: there is no safe default for a public template, so we
//                read it from the environment and fail loudly below if it's missing.
// BUYER_WALLET — the public address that funds escrows. It only appears in the
//                block-explorer link we email back, so the principal can verify the
//                on-chain transaction. Read from env; no hardcoded address in a
//                public repo. See .env.example for the variable names.
const INBOX = process.env.BUYER_INBOX;
const BUYER_WALLET = process.env.BUYER_WALLET;
const POLL_MS = Number(process.env.POLL_MS || 8000);          // inbox poll interval
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 4); // in-flight commissions cap
const MAX_BUDGET = Number(process.env.MAX_BUDGET || 25);      // hard cap (defuses prompt-injected budget inflation)
const ORACLE_FLOOR = Number(process.env.ORACLE_FLOOR || 8);   // provider won't take a job below this

// Fail closed if the inbox isn't configured — better than silently polling nothing.
if (!INBOX) throw new Error('BUYER_INBOX is required (set it in .env — see .env.example)');

// Block-explorer deep link we attach to confirmations so the principal can audit the
// on-chain token transfers themselves. (Base Sepolia testnet explorer here; swap the
// host for mainnet when you graduate off testnet.)
const TX = (id) => `https://sepolia.basescan.org/address/${BUYER_WALLET}#tokentxns`;

// AgentMail client — the entire email transport. API key from the environment only.
const client = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Extract the bare address out of a "Name <addr@host>" From header.
const emailOf = (f) => { const m = String(f || '').match(/<([^>]+)>/); return (m ? m[1] : String(f || '')).trim(); };
// Short human-friendly reference tag derived from an idempotency key (e.g. "9F2A1C").
const refOf = (key) => String(key).slice(0, 6).toUpperCase();
let _active = 0; // count of commissions currently running off the poll loop

// --- approval detection (mode A) — strip quoted reply history first ----------
// When a principal replies "approve", their mail client usually quotes the whole
// previous thread. We strip that quoted history so we only test the words THEY just
// typed — otherwise an earlier "approve" in the quote could trigger a false release.
function stripQuoted(body) {
  return String(body || '')
    .replace(/\n--\nSent via AgentMail[\s\S]*$/i, '')                              // drop AgentMail signature
    .split(/\n\s*(?:On .+wrote:|-{3,}\s*Original|_{5,}|From:\s)/i)[0]              // cut at the quote header
    .split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').trim();               // drop ">" quoted lines
}
// Intent matchers accept both English and Croatian phrasings (the principal here is
// bilingual). These are deliberately broad but gated by the "pending escrow" check
// in handle(), so they can't fire unless a held escrow is actually awaiting a call.
const isApproval = (s) => /\b(approve|approved|release|go ahead|pay (?:him|it|them|oracle)|looks good|ship it|odobravam|pusti|plati|može|idemo|samo naprijed)\b/i.test(s);
const isReject = (s) => /\b(reject|decline|deny|do ?n.?t (?:pay|release|settle)|hold off|withhold|cancel|ne pla(?:ć|c)aj|ne pu(?:š|s)taj|odbij|nemoj)\b/i.test(s);

// Only converse with real external human senders — skip our own outbound mail, the
// provider/Oracle agent, and system notifications, so agents don't talk in loops.
function isConversational(item) {
  const from = (item.from || '').toLowerCase();
  const subj = item.subject || '';
  if (from.includes('@agentmail.to')) return false;            // self / Oracle / system (other agents live on agentmail.to)
  if (/^\s*(re:\s*)?\[ACTP-/i.test(subj) || subj.includes('Intel brief')) return false; // protocol/provider traffic
  return true;
}

// Reliable send: AgentMail send with up to 3 attempts and backoff. Attachments
// (the brief as JSON/PDF) are passed through untouched when present.
async function sendMail(to, subject, text, attachments) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await client.inboxes.messages.send(INBOX, { to: [to], subject, text, ...(attachments ? { attachments } : {}) });
      if (r) return true;
    } catch (e) { if (i === 2) { console.error('[Atlas] send failed:', e.message); return false; } await sleep(2500); }
  }
  return false;
}

// Render the brief as readable inline text. We always inline the brief in the email
// body (not only as an attachment) so it survives gateways that strip attachments.
function renderBriefInline(topic, brief) {
  const secs = (brief.sections || []).map((s) => `\n## ${s.title}\n${s.body}`).join('\n');
  const src = (brief.sources || []).length ? `\n\nSOURCES:\n${(brief.sources || []).map((x) => '- ' + x).join('\n')}` : '';
  return `Topic: ${topic}\n\n${brief.summary || ''}\n${secs}${src}`;
}

// Build email attachments for a delivered brief: always a JSON copy (machine-readable,
// keyed by a short slice of the on-chain txId for traceability) and, if rendering
// succeeded, a PDF placed first so it's the "primary" attachment.
function briefAttachments(topic, txId, brief, pdf) {
  const short = String(txId).slice(0, 10);
  const json = JSON.stringify(brief, null, 2);
  const a = [{ filename: `brief-${short}.json`, content: Buffer.from(json).toString('base64') }];
  if (pdf) a.unshift({ filename: `brief-${short}.pdf`, content: pdf.toString('base64') });
  return a;
}

// --- the commission worker (runs off the poll loop) --------------------------
// This is the full ACTP escrow lifecycle for one commission:
//   negotiate price → open+fund escrow (escrowHold) → on delivery either HOLD for
//   review (mode A) or settle automatically. Each step is persisted via st.* so a
//   crash mid-flight is recoverable by reconcile().
async function runCommission({ from, key, ref, topic, budget, review }) {
  console.log(`[Atlas] [${ref}] commission "${topic.slice(0, 50)}" budget $${budget} review=${review}`);
  try {
    // 1) Negotiate a price with the provider, capped at the principal's budget.
    const neg = await negotiate({ topic, maxBudget: budget, onState: (s) => console.log(`[Atlas] [${ref}] neg: ${s}`) });
    console.log(`[Atlas] [${ref}] ${neg.summary}`);
    if (neg.price < ORACLE_FLOOR) {
      // Provider's floor is above budget → abort cleanly. No funds were moved.
      st.setCommitted(key, { state: 'ABORTED' });
      await sendMail(from, `Can't commission that — minimum is $${ORACLE_FLOOR} (ref ${ref})`,
        `Oracle's minimum for an intel brief is $${ORACLE_FLOOR}, and your budget tops out at $${budget}. No money was moved.\n— Atlas`);
      return;
    }

    // 2) Open + fund the on-chain escrow and await delivery. escrowHold() walks the
    //    ACTP state machine (INITIATED → COMMITTED → IN_PROGRESS → DELIVERED) and
    //    returns the txId, locked amount, and the brief if the provider delivered.
    const r = await escrowHold({ topic, price: neg.price, onState: (s) => console.log(`[Atlas] [${ref}]   ${s}`) });
    st.setCommitted(key, { txId: r.txId, amount: r.amount, state: r.state });

    if (!r.brief || (r.state !== 'DELIVERED' && r.state !== 'SETTLED')) {
      // No delivery. Either the escrow was cancelled+refunded, or the funds remain
      // safely locked and auto-refund at the on-chain deadline. Reassure the principal
      // that money is never stuck, and that we'll resume if the provider returns.
      const refundLine = r.refunded
        ? `Your $${r.amount} escrow was cancelled and refunded — you were not charged.`
        : `Your $${r.amount} is held in on-chain escrow — it returns to you automatically at the deadline if Oracle never delivers, and I'll resume automatically if Oracle comes back online.`;
      await sendMail(from, `Delayed: your brief (ref ${ref})`,
        `I commissioned the brief on "${topic}" but Oracle hasn't delivered yet (state: ${r.state}).\n${refundLine}\n— Atlas`);
      console.log(`[Atlas] [${ref}] no delivery (state ${r.state}, refunded=${r.refunded})`);
      return;
    }

    // 3) Delivered. Render the brief (PDF best-effort; inline text always) and decide
    //    between review-gated release (mode A) and autonomous settlement.
    const pdf = await renderBriefPdf({ topic, txId: r.txId, brief: r.brief }).catch(() => null);
    const attachments = briefAttachments(topic, r.txId, r.brief, pdf);
    const inline = renderBriefInline(topic, r.brief);

    if (review) {
      // MODE A — human-in-the-loop. Park a "pending" record keyed by the sender so
      // their next reply ("approve"/"reject") is interpreted as a release decision.
      // The escrow stays in DELIVERED (funds HELD); nothing is paid out yet.
      st.setPending(from, { txId: r.txId, topic, amount: r.amount, durationMs: r.durationMs, ref, key });
      st.setCommitted(key, { state: 'DELIVERED' });
      await sendMail(from, `Your brief is ready — approve to release $${r.amount}? [ref ${ref}]`,
        `Oracle delivered the brief on "${topic}". ${neg.summary}\n\n` +
        `The $${r.amount} is escrowed on-chain and HELD — nothing is released yet.\n` +
        `► Reply "approve" to release payment, or "reject" to withhold it (you keep the brief either way).\n` +
        `  · Verify tx: ${TX(r.txId)}\n\n` +
        `———————————— BRIEF ————————————\n${inline}\n\n— Atlas`,
        attachments);
      console.log(`[Atlas] [${ref}] brief sent for review (held $${r.amount}, tx ${String(r.txId).slice(0, 10)}…)`);
    } else {
      // AUTONOMOUS — settle immediately. settle() releases funds to the provider and
      // confirms the transition to SETTLED on-chain before we report success.
      const s = await settle(r.txId, r.amount, r.durationMs);
      st.setCommitted(key, { state: s.ok ? 'SETTLED' : 'DELIVERED', receiptUrl: s.receiptUrl || null });
      await sendMail(from, `Your brief: ${topic.slice(0, 50)} — ${s.ok ? `settled $${r.amount}` : 'delivered'} [ref ${ref}]`,
        `Oracle delivered the brief on "${topic}". ${neg.summary}\n` +
        `${s.ok ? `Released $${r.amount} to Oracle — settled on-chain.` : `Delivered; settlement is finalizing.`}\n` +
        (s.receiptUrl ? `  · Receipt:     ${s.receiptUrl}\n` : '') +
        `  · Verify tx:  ${TX(r.txId)}\n\n` +
        `———————————— BRIEF ————————————\n${inline}\n\n— Atlas`,
        attachments);
      console.log(`[Atlas] [${ref}] autonomous delivery ${s.ok ? `SETTLED $${r.amount}` : 'NOT settled'}${s.receiptUrl ? ' +receipt' : ''}`);
    }
  } catch (e) {
    // Any failure → mark ERROR and tell the principal nothing was settled. The escrow
    // (if opened) stays recoverable; a re-send or the reconciler can finish it.
    console.error(`[Atlas] [${ref}] commission failed:`, e.message);
    st.setCommitted(key, { state: 'ERROR', error: e.message });
    await sendMail(from, `Snag on your brief (ref ${ref})`, `I hit a snag: ${e.message}\nNo settlement happened. Reply and I'll retry.\n— Atlas`).catch(() => {});
  }
}

// Release a held escrow on the principal's approval (mode A path).
async function approveAndSettle(from, p) {
  console.log(`[Atlas] [${p.ref}] APPROVED — releasing $${p.amount}`);
  await sendMail(from, `Releasing $${p.amount} now [ref ${p.ref}]`, `On it — releasing payment to Oracle and confirming on-chain.\n— Atlas`);
  // settle() drives DELIVERED → SETTLED. On any throw we keep ok:false so we don't
  // make a false "paid" promise to the principal.
  const s = await settle(p.txId, p.amount, p.durationMs).catch((e) => ({ ok: false, receiptUrl: null, state: e.message }));
  if (p.key) st.setCommitted(p.key, { state: s.ok ? 'SETTLED' : 'DELIVERED', receiptUrl: s.receiptUrl || null });
  if (s.ok) {
    await sendMail(from, `Payment released — $${p.amount} settled [ref ${p.ref}]`,
      `Done — released $${p.amount} to Oracle, settled on-chain.\n` +
      (s.receiptUrl ? `  · Receipt:    ${s.receiptUrl}\n` : '') +
      `  · Verify tx:  ${TX(p.txId)}\n— Atlas`);
    console.log(`[Atlas] [${p.ref}] SETTLED $${p.amount}${s.receiptUrl ? ' +receipt' : ''}`);
  } else {
    // settle didn't confirm — keep the job recoverable (re-arm pending) so a
    // re-"approve" or the boot reconciler can finish it. No false promise.
    st.setPending(from, p);
    await sendMail(from, `Couldn't confirm the release [ref ${p.ref}]`,
      `I broadcast the release but couldn't confirm it settled (state: ${s.state}). The escrow is safe; reply "approve" again and I'll re-confirm.\n— Atlas`);
    console.log(`[Atlas] [${p.ref}] settle unconfirmed (state ${s.state}) — re-armed`);
  }
}

// Human-readable status line for a duplicate/again request about an existing commission.
function statusReply(c) {
  switch (c.state) {
    case 'PENDING': case 'COMMITTED': case 'IN_PROGRESS': return `I'm still working on that one (ref ${c.ref}) — the brief is on its way.`;
    case 'DELIVERED': return `I already sent you that brief (ref ${c.ref}); it's awaiting your "approve" to release payment.`;
    case 'SETTLED': return `That brief was already delivered and settled (ref ${c.ref}).` + (c.receiptUrl ? ` Receipt: ${c.receiptUrl}` : '');
    default: return `I already handled that request (ref ${c.ref}, ${c.state}).`;
  }
}

// Handle one inbound email end to end.
async function handle(item) {
  const id = item.messageId || item.message_id;
  // Fetch the full message body via AgentMail (the list view is metadata-only).
  const full = await client.inboxes.messages.get(INBOX, id).catch(() => null);
  const from = emailOf(item.from);
  const subject = item.subject || '(no subject)';
  const body = String((full && full.text) || '').replace(/\n--\nSent via AgentMail[\s\S]*$/i, '').trim();
  const reSubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;

  // --- Mode A decision gate: a held escrow awaits this sender's call ----------
  // If we're holding a delivered-but-unpaid escrow for this sender, their reply is
  // first interpreted as approve/reject before anything else.
  const p = st.getPending(from);
  if (p) {
    const clean = stripQuoted(body);
    const appr = isApproval(clean), rej = isReject(clean);
    if (appr && rej) {
      // Ambiguous — both intents present. Ask for a one-word answer rather than guess.
      await sendMail(from, `Quick check [ref ${p.ref}]`, `I read both "approve" and "reject" in there — reply with just one word so I don't get it wrong.\n— Atlas`);
      return;
    }
    if (rej) {
      // Withhold payment. Principal keeps the brief; escrow returns to them after the
      // on-chain dispute window. Clear pending + mark the commission REJECTED.
      st.clearPending(from);
      if (p.key) st.setCommitted(p.key, { state: 'REJECTED' });
      await sendMail(from, `Held — not releasing [ref ${p.ref}]`, `Understood — I won't release the $${p.amount}. You keep the brief; the escrow returns to you after the dispute window.\n— Atlas`);
      console.log(`[Atlas] [${p.ref}] REJECTED`);
      return;
    }
    if (appr) { st.clearPending(from); await approveAndSettle(from, p); return; }
    // Neither approve nor reject while pending → treat as a normal message below.
  }

  // --- Understand the email with the brain (LLM) ------------------------------
  console.log(`[Atlas] ✉ from ${from} · "${subject}" — understanding…`);
  let u;
  try {
    // Give the brain the sender's most recent commission topic as light context.
    const recent = (st.allCommitted().filter(([, c]) => c.from === from).map(([, c]) => c).pop() || {}).topic;
    u = await understand({ from, subject, body, recent });
  } catch (e) {
    console.error('[Atlas] understand() failed:', e.message);
    await sendMail(from, reSubject, `Sorry — I had trouble reading that. Could you resend in a sentence what brief you'd like?\n— Atlas`);
    return;
  }

  if (u.kind === 'commission' && u.topic && u.topic.trim()) {
    // Deterministic exactly-once: identical resends map to the same idempotency key
    // (derived from sender+subject+body) → one escrow, never a duplicate charge.
    const key = st.idemKey(from, subject, body);
    const existing = st.getCommitted(key);
    if (existing && ['PENDING', 'COMMITTED', 'IN_PROGRESS', 'DELIVERED', 'SETTLED'].includes(existing.state)) {
      // We've already seen this exact request — reply with its status, don't re-order.
      await sendMail(from, `Re: ${subject} [ref ${refOf(key)}]`, `${statusReply({ ...existing, ref: refOf(key) })}\n— Atlas`);
      console.log(`[Atlas] dup commission ${refOf(key)} (${existing.state}) — not re-ordered`);
      return;
    }
    const ref = refOf(key);
    // Clamp the budget: floor 1, default 10, hard-capped at MAX_BUDGET. The cap is a
    // safety rail against prompt injection inflating the spend via the email text.
    const budget = Math.min(Math.max(Number(u.budget) || 10, 1), MAX_BUDGET);
    // Persist PENDING BEFORE doing on-chain work, so a crash leaves a recoverable record.
    st.setCommitted(key, { from, topic: u.topic, amount: budget, state: 'PENDING', createdAt: new Date().toISOString(), ref });
    await sendMail(from, `Re: ${subject} — on it [ref ${ref}]`,
      `Got it. I'm sourcing a brief on "${u.topic}" from a provider on the network, negotiating the price, and ${u.review ? 'will send it to you to review before releasing any payment' : 'will deliver it and settle automatically'}. I'll email the brief here when it's ready (ref ${ref}).\n— Atlas`);
    await runCommission({ from, key, ref, topic: u.topic, budget, review: !!u.review });
  } else {
    // Not a commission → plain conversational reply from the brain.
    await sendMail(from, reSubject, u.reply || `Atlas here — could you tell me a bit more about what you need?`);
    console.log(`[Atlas] → replied (chat) to ${from}`);
  }
}

// --- boot reconciliation: never strand a funded escrow across a restart -------
// On startup (and periodically), re-check every persisted in-flight escrow against
// the chain so a restart can never lose track of money or a delivered brief.
async function reconcile() {
  // Re-verify pending (mode-A awaiting approval): drop ones already settled/gone.
  for (const [from, p] of st.allPending()) {
    const s = await txStatus(p.txId).catch(() => null);
    if (s === 'SETTLED' || s === 'CANCELLED' || s === null) { st.clearPending(from); console.log(`[Atlas] reconcile: cleared stale pending ${p.ref} (${s})`); }
    else console.log(`[Atlas] reconcile: re-armed pending ${p.ref} (${s}) for ${from}`);
  }
  // Resume commissions that were mid-flight when we died.
  for (const [key, c] of st.allCommitted()) {
    if (!c.txId || ['SETTLED', 'CANCELLED', 'REJECTED', 'ABORTED', 'ERROR'].includes(c.state)) continue;
    const s = await txStatus(c.txId).catch(() => null);
    if (s === 'SETTLED') { st.setCommitted(key, { state: 'SETTLED' }); continue; }
    if (s === 'DELIVERED' && !st.getPending(c.from)) {
      // Delivered while we were down and not yet awaiting approval → re-arm review.
      // Re-fetch the brief from the escrow record and re-send the approval request.
      const { brief } = await fetchBrief(c.txId).catch(() => ({ brief: null }));
      if (brief) {
        st.setPending(c.from, { txId: c.txId, topic: c.topic, amount: c.amount, durationMs: 0, ref: c.ref, key });
        st.setCommitted(key, { state: 'DELIVERED' });
        await sendMail(c.from, `Your brief is ready — approve to release $${c.amount}? [ref ${c.ref}]`,
          `Oracle delivered the brief on "${c.topic}". The $${c.amount} is escrowed and HELD.\n► Reply "approve" to release, or "reject" to withhold.\n  · Verify tx: ${TX(c.txId)}\n\n———————————— BRIEF ————————————\n${renderBriefInline(c.topic, brief)}\n\n— Atlas`,
          briefAttachments(c.topic, c.txId, brief, await renderBriefPdf({ topic: c.topic, txId: c.txId, brief }).catch(() => null)));
        console.log(`[Atlas] reconcile: resumed DELIVERED ${c.ref} → review`);
      }
    }
  }
}

// One pass of the inbox poll loop.
async function pollOnce() {
  const list = await client.inboxes.messages.list(INBOX, { limit: 15 });
  // Oldest-first so we process a thread in order; reverse() because list() is newest-first.
  for (const item of (list?.messages || []).slice().reverse()) {
    const id = item.messageId || item.message_id;
    if (!id || st.hasSeen(id)) continue;                       // durable de-dup across restarts
    if (!isConversational(item)) { st.markSeen(id); continue; } // skip self/agent/system mail
    if (_active >= MAX_CONCURRENT) break;                       // back-pressure: NOT marked seen → retried next poll
    st.markSeen(id);                                            // mark seen BEFORE handling → never double-process
    _active++;
    handle(item).catch((e) => console.error('[Atlas] handle failed (continuing):', e.message)).finally(() => { _active--; });
  }
}

// Entry point: prime the seen-set on a fresh start, reconcile, then poll forever.
async function main() {
  console.log(`◬ Atlas — buyer agent, listening on ${INBOX}`);
  // Prime: ignore inbox history on a FRESH state file; a returning Atlas keeps its
  // seen-set so it doesn't replay, and reconciles any in-flight escrows.
  const fresh = st.allCommitted().length === 0 && st.allPending().length === 0;
  const init = await client.inboxes.messages.list(INBOX, { limit: 50 }).catch(() => null);
  if (fresh) { st.primeSeen((init?.messages || []).map((m) => m.messageId || m.message_id)); console.log(`[Atlas] fresh start — primed ${(init?.messages || []).length} existing messages.`); }
  await reconcile().catch((e) => console.error('[Atlas] reconcile error:', e.message));
  // Periodic reconcile: a held escrow that Oracle delivers late (after a recovery)
  // gets resumed without waiting for a restart.
  setInterval(() => reconcile().catch((e) => console.error('[Atlas] periodic reconcile error:', e.message)), 5 * 60 * 1000);
  console.log(`[Atlas] ready. Email ${INBOX} from your mail client.`);
  for (;;) {
    await pollOnce().catch((e) => console.error('[Atlas] poll error (continuing):', e.message));
    await sleep(POLL_MS);
  }
}
if (require.main === module) {
  main().catch((e) => { console.error('[Atlas] FATAL:', e.message); process.exit(1); });
}

// Exported for unit testing the pure helpers (no network/chain side effects).
module.exports = { stripQuoted, isApproval, isReject, isConversational, renderBriefInline, refOf };
