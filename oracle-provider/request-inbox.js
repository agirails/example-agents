// Oracle (provider) — mail intake + brief delivery over AgentMail.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// ACTP escrow is opened on-chain with a `serviceDescription` that is just a
// bytes32 routing hash (keccak256 of the service name) — it CANNOT carry the
// actual job text (the topic the buyer wants a brief about). The SDK has no
// on-chain field for free-form input. So the protocol splits responsibilities:
//
//   • On-chain (ACTP):  who pays whom, how much, and the service-routing hash.
//   • Off-chain (email): the human-readable payload — the request topic going
//                        IN, and the finished brief coming back OUT.
//
// The two halves are stitched together by the transaction id (`txId`):
//   1. The buyer opens escrow on-chain (gets a txId), then emails Oracle's inbox
//      with subject "[ACTP-REQUEST] <txId>" and the topic in the body.
//   2. Oracle polls its inbox, finds the message whose subject contains that
//      txId, reads the topic, and produces the brief.
//   3. Oracle emails the brief BACK to the request sender (the buyer), again
//      tagging the FULL txId in the subject so the buyer can correlate it to the
//      escrow it funded.
//
// This module is the pure email-transport layer (no chain calls live here):
//   • fetchTopic()   — INTAKE:   poll the inbox until the buyer's request arrives.
//   • parseRequest() — PARSE:    turn the email body into a structured request.
//   • deliverBrief() — DELIVERY: email the finished brief back to the buyer.
//   • renderBrief*() — RENDER:   format the brief as HTML / plain text.
//
// The ACTP escrow lifecycle (createTransaction → COMMITTED → IN_PROGRESS →
// DELIVERED → SETTLED) is driven elsewhere (escrow/commerce module); this file
// only handles the off-chain message that rides alongside it.

// AgentMail is the email transport for agent↔agent (and agent↔human) mail.
// One client, authenticated by an API key, can list/read/send on an inbox.
const { AgentMailClient } = require('agentmail');
// Best-effort PDF renderer for the delivered brief (see ./pdf.js). Optional:
// delivery still succeeds with just the JSON/text twin if PDF rendering fails.
const { renderBriefPdf } = require('./pdf');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Extract the bare address out of a "Name <addr@host>" From header, lowercased,
// so we can reply to exactly the buyer who sent the request.
const emailOf = (from) => {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
};

// Oracle's OWN AgentMail inbox — where buyers send requests TO and Oracle sends
// briefs FROM. Read from the environment ONLY; a public template must never ship
// a real inbox address. See .env.example for the variable name. (We resolve it
// lazily inside each function so callers can also pass it explicitly via opts.)
const ORACLE_INBOX = process.env.ORACLE_INBOX;

/** Parse the email body into { topic, scope?, audience? } (or null if empty). */
function parseRequest(rawBody) {
  const clean = String(rawBody || '')
    .replace(/\n--\nSent via AgentMail[\s\S]*$/i, '') // strip the AgentMail footer
    .trim();
  // Pull a "LABEL: value" line out of the body if the buyer used a structured form.
  const grab = (label) => {
    const m = clean.match(new RegExp(label + '\\s*:\\s*(.+)', 'i'));
    return m ? m[1].trim() : undefined;
  };
  const topic = grab('TOPIC');
  // Structured request: an explicit TOPIC line, with optional SCOPE / AUDIENCE.
  if (topic) return { topic, scope: grab('SCOPE'), audience: grab('AUDIENCE') };
  // Unstructured request: treat the whole body as a natural-language topic.
  return clean ? { topic: clean } : null;
}

/**
 * INTAKE step. Find the buyer's request email for `txId` and return
 * { topic, scope?, audience?, replyTo }, or null if none arrives in time.
 *
 * This is the off-chain half of "the buyer committed escrow on-chain, now tell
 * me what they actually want." We poll because email is asynchronous: the buyer
 * may send the request a few seconds after (or before) the escrow confirms.
 *
 * @param txId  the on-chain transaction id linking this email to its escrow.
 * @param opts  { apiKey?, inboxId?, retries?, delayMs? } — overrides for the
 *              env-sourced API key/inbox and the poll cadence.
 */
async function fetchTopic(txId, opts = {}) {
  // Secrets/identity come from the environment (or explicit opts) — never hardcoded.
  const apiKey = opts.apiKey || process.env.AGENTMAIL_API_KEY;
  const inboxId = opts.inboxId || ORACLE_INBOX; // Oracle's own inbox (env: ORACLE_INBOX)
  const retries = opts.retries ?? 6;            // ~6 attempts...
  const delayMs = opts.delayMs ?? 5000;         // ...5s apart ≈ 30s of polling.
  // Without an API key there's nothing to poll — return null rather than throw,
  // since the caller may legitimately run without an inbox configured (e.g. tests).
  if (!apiKey) return null;

  const client = new AgentMailClient({ apiKey });

  for (let attempt = 0; attempt < retries; attempt++) {
    // List the most recent inbox messages (metadata only — bodies are fetched on demand).
    const list = await client.inboxes.messages.list(inboxId, { limit: 30 }).catch(() => null);
    for (const item of list?.messages ?? []) {
      const subj = item.subject || '';
      // Match the FULL txId only — a 10-char prefix can collide between two
      // concurrent jobs and deliver the wrong topic to the wrong buyer.
      if (subj.includes('[ACTP-REQUEST]') && subj.includes(String(txId))) {
        // Found the request: fetch the full message to read its body, then parse it.
        const id = item.messageId || item.message_id;
        const full = await client.inboxes.messages.get(inboxId, id).catch(() => null);
        const parsed = parseRequest(full && full.text);
        // Capture replyTo from the From header so deliverBrief() emails the right buyer.
        if (parsed) return { ...parsed, replyTo: emailOf(item.from || (full && full.from)) };
      }
    }
    // Not here yet — wait and poll again (skip the wait after the final attempt).
    if (attempt < retries - 1) await sleep(delayMs);
  }
  return null; // request never showed up within the polling window
}

// --- Brief rendering --------------------------------------------------------
// HTML-escape so brief content (which may include LLM-generated text) can't
// break the email markup or inject tags.
const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Render the brief as a styled HTML card (dark "intel terminal" theme). Used for
// rich-client email previews; the plain-text twin below is the fallback.
function renderBriefHtml({ topic, txId, brief }) {
  const sections = (brief.sections || [])
    .map((s) => `<div style="margin:18px 0"><div style="color:#d8a657;font-weight:600;font-size:15px">${esc(s.title)}</div><div style="color:#e7e4da;margin-top:4px;line-height:1.5">${esc(s.body)}</div></div>`)
    .join('');
  const sources = (brief.sources || []).length
    ? `<div style="margin-top:22px;border-top:1px solid #2a2f2c;padding-top:12px"><div style="color:#7fb069;font-size:12px;letter-spacing:1px">SOURCES</div>${(brief.sources || []).map((x) => `<div style="color:#9aa39c;font-size:12px;margin-top:4px">• ${esc(x)}</div>`).join('')}</div>`
    : '';
  return `<div style="background:#0c0e0d;color:#e7e4da;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:28px;max-width:640px;margin:0 auto">
  <div style="background:#141816;border:1px solid #2a2f2c;border-radius:10px;padding:26px">
    <div style="display:flex;align-items:center;gap:8px"><span style="color:#d8a657;font-size:20px">◬</span><span style="color:#9aa39c;font-size:12px;letter-spacing:2px">ORACLE · INTEL BRIEF</span></div>
    <h2 style="color:#e7e4da;font-size:19px;margin:14px 0 4px">${esc(topic)}</h2>
    <div style="color:#6b746d;font-size:11px;font-family:monospace">tx ${esc(String(txId).slice(0, 18))}…</div>
    <div style="color:#e7e4da;margin:18px 0;line-height:1.6;border-left:2px solid #d8a657;padding-left:12px">${esc(brief.summary)}</div>
    ${sections}
    ${sources}
    <div style="margin-top:24px;color:#6b746d;font-size:11px">Delivered over AgentMail · settled on Base · ◬ AGIRAILS</div>
  </div>
</div>`;
}

// Render the brief as plain text. Agent↔agent mail stays plain so it survives any
// gateway and is trivially machine-parseable.
function renderBriefText({ topic, brief }) {
  const secs = (brief.sections || []).map((s) => `## ${s.title}\n${s.body}`).join('\n\n');
  const src = (brief.sources || []).length ? `\nSOURCES:\n${(brief.sources || []).map((x) => '- ' + x).join('\n')}` : '';
  return `◬ ORACLE — INTEL BRIEF\nTopic: ${topic}\n\n${brief.summary}\n\n${secs}${src}`;
}

/**
 * DELIVERY step. Email the finished brief back to the buyer (HTML + text), and
 * attach the structured JSON twin for machine consumption / autonomous verify.
 *
 * This is the off-chain counterpart to the ACTP DELIVERED state: once the
 * provider produces the brief and sends it here, the buyer can verify it and
 * release escrow (SETTLED). A failed delivery must NOT look like success — see
 * the throw-on-error decisions below — because the buyer is paying for a brief
 * that has to actually leave this machine.
 *
 * @param to        the buyer's email (use the `replyTo` from fetchTopic()).
 * @param txId      the on-chain transaction id, tagged into the subject.
 * @param topic     the requested topic (echoed into subject/body).
 * @param brief     the produced brief { summary, sections[], sources[] }.
 * @param apiKey    AgentMail API key (defaults to env).
 * @param fromInbox Oracle's own inbox to send FROM (defaults to env ORACLE_INBOX).
 */
async function deliverBrief({ to, txId, topic, brief, apiKey, fromInbox } = {}) {
  // Resolve secrets/identity from env when not passed explicitly. No hardcoded
  // inbox address — a public template reads it from ORACLE_INBOX (see .env.example).
  apiKey = apiKey || process.env.AGENTMAIL_API_KEY;
  fromInbox = fromInbox || ORACLE_INBOX;
  // THROW (not return false) on missing config — a silent zero-delivery would let
  // the buyer pay for a brief that never left this machine.
  if (!apiKey) throw new Error('deliverBrief: AGENTMAIL_API_KEY missing');
  if (!fromInbox) throw new Error('deliverBrief: ORACLE_INBOX missing (set it in .env — see .env.example)');
  if (!to) throw new Error('deliverBrief: no recipient (to)');

  const client = new AgentMailClient({ apiKey });
  const short = String(txId).slice(0, 10); // short tag for attachment filenames
  // The structured JSON twin: the same brief in machine-readable form so a buyer
  // agent can parse/verify it programmatically (not just read the prose).
  const json = JSON.stringify({ topic, txId, ...brief }, null, 2);
  const attachments = [{ filename: `oracle-brief-${short}.json`, content: Buffer.from(json).toString('base64') }];
  // Best-effort PDF, placed FIRST so it's the "primary" attachment when present.
  // If rendering throws, we still deliver with JSON-only (delivery must not fail
  // just because the pretty PDF couldn't be built).
  const pdf = await renderBriefPdf({ topic, txId, brief }).catch(() => null);
  if (pdf) attachments.unshift({ filename: `oracle-brief-${short}.pdf`, content: pdf.toString('base64') });
  // Plain text body (agent↔agent stays plain) + PDF/JSON attachments. The FULL
  // txId rides in the subject so the buyer can correlate without prefix collisions.
  const res = await client.inboxes.messages.send(fromInbox, {
    to: [to],
    subject: `Intel brief [${txId}] — ${topic.slice(0, 50)}`,
    text: renderBriefText({ topic, brief }) + '\n\n--- machine-readable ---\n' + json,
    attachments,
  });
  // Confirm the send actually registered — a swallowed non-2xx would otherwise
  // look like success (the receipt-push 400 class of bug). Throw if no id came back.
  const id = res && (res.messageId || res.message_id || res.id);
  if (!id) throw new Error('deliverBrief: AgentMail send returned no message id');
  return true;
}

module.exports = { fetchTopic, parseRequest, deliverBrief, renderBriefHtml, renderBriefText };
