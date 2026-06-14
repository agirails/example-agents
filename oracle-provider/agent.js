// Oracle — AGIRAILS research PROVIDER (teaching template)
// ─────────────────────────────────────────────────────────────────────────────
// A research agent that delivers concise, sourced intel briefs on a requested
// topic and EARNS USDC on the AGIRAILS network (Base Sepolia testnet) via ACTP
// escrow. This is the "seller" side of the marketplace; the matching "buyer"
// lives in the sibling `atlas-buyer/` template.
//
// HOW THE WHOLE THING FITS TOGETHER (the 30-second mental model):
//   1. A buyer escrows USDC on-chain for the "intel-brief" service.
//   2. The SDK's event poller sees that escrow and invokes our handler below.
//   3. The buyer's actual TOPIC + reply address arrive out-of-band over email
//      (AgentMail), correlated by the on-chain transaction id (txId).
//   4. Our "brain" (Claude) researches the topic and produces a JSON brief.
//   5. We email the brief back to the buyer. Email delivery is a HARD success
//      precondition — only after it lands do we let the job settle on-chain.
//   6. The SDK advances the ACTP state machine to DELIVERED → SETTLED, which
//      releases the escrowed USDC to our wallet.
//
// Run:  node agent.js
// The SDK is CommonJS — there is no top-level await, so everything runs inside
// an async main() that we invoke at the bottom of the file.
// ─────────────────────────────────────────────────────────────────────────────

// Load secrets/config from the environment. `.env` holds things like
// ACTP_KEY_PASSWORD (wallet keystore password); `.env.local` holds the keyed
// RPC URL (BASE_SEPOLIA_RPC). Both files are gitignored — see .env.example for
// the schema. dotenv is layered: later loads do NOT overwrite already-set vars,
// so process-level env still wins over the files.
require('dotenv').config();
require('dotenv').config({ path: '.env.local' });

// The free public Base Sepolia RPC (sepolia.base.org) caps eth_getLogs at 2000
// blocks and drops persistent filters — both of which break the SDK's
// long-running event poller (it would silently miss escrow events). For anything
// beyond a quick smoke test, set BASE_SEPOLIA_RPC in .env.local to a keyed
// provider (Alchemy / Infura / QuickNode). We only warn here; the SDK still
// boots on the public node so newcomers can try it without an account.
if (!process.env.BASE_SEPOLIA_RPC) {
  console.warn('[Oracle] WARNING: BASE_SEPOLIA_RPC not set — falling back to public RPC (event poller will be unreliable).');
}

const fs = require('node:fs');
const path = require('node:path');
const { Agent } = require('@agirails/sdk');
// Oracle's "brain": calls Claude to actually research the topic and write the
// brief. The brain handles its own auth (no key wired in here).
const { generateBrief } = require('./brain');
// Email transport (AgentMail): fetchTopic pulls the buyer's topic + reply
// address IN (step 3 above), deliverBrief sends the finished brief OUT (step 5).
const { fetchTopic, deliverBrief } = require('./request-inbox');
// Plain-text price negotiation over email, BEFORE any escrow exists (pre-escrow
// handshake). The agreed price is what the buyer then escrows on-chain.
const { startNegotiator } = require('./negotiate');

// ── Durable delivered-ledger ────────────────────────────────────────────────
// Maps txId -> { topic, deliveredAt }. We write to it AFTER a brief email is
// confirmed sent. Because it lives on disk, it survives restarts: a brief that
// was already paid for AND delivered will never be re-generated (~100s of Claude
// time) or re-emailed (a duplicate to the buyer) by a later catch-up sweep.
const LEDGER_PATH = path.join(__dirname, '.oracle-delivered.json');
function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); } catch { return {}; }
}
function alreadyDelivered(txId) { return !!loadLedger()[txId]; }
function markDelivered(txId, topic) {
  const l = loadLedger();
  l[txId] = { topic, deliveredAt: new Date().toISOString() };
  try { fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2)); }
  catch (e) { console.error('[Oracle] ledger write failed:', e.message); }
}

const NETWORK = 'testnet';   // 'mock' | 'testnet' | 'mainnet'

// Pricing — mirrors the oracle.md identity file (negotiable $8–$12, base $10).
// `floor` is enforced on-protocol via the provide() filter below; the rest is
// used by the off-chain negotiator.
const PRICE = {
  base: 10,   // headline / list price (USDC)
  floor: 8,   // minimum acceptable — reject jobs below this
  ceiling: 12,
};

const CONCURRENCY = 3;       // matches sla.concurrency in the identity file

// ── Idempotency guards ──────────────────────────────────────────────────────
// The SDK can re-enter a job (e.g. its IN_PROGRESS catch-up sweep fires while
// the first run is still in flight). Research + delivery must happen EXACTLY
// once per txId, so we track work in-memory for the current process and on disk
// (the ledger above) across restarts.
const _generated = new Map(); // txId -> brief (kept so a delivery-only retry reuses it and we never re-pay for Claude)
const _inFlight = new Set();   // txId currently being produced in THIS process

// ── Service handler ─────────────────────────────────────────────────────────
// intel-brief: produce a concise, sourced 1-page intel brief on a topic.
// job.input may be plain text (natural-language) or a structured object
//   { topic, scope?, sections?, audience? }.
// Returns a JSON brief { summary, sections[], sources[] }; a PDF rendering is
// handled out-of-band via the AgentMail / Relay delivery channel.

async function intelBrief(job, ctx) {
  // Durable cross-restart guard: if this tx was already delivered+emailed (even
  // in a prior process), return WITHOUT re-generating or re-emailing so the SDK
  // can just (re)finalize the on-chain DELIVERED hop. No double brief, no re-pay.
  if (alreadyDelivered(job.id)) {
    return _generated.get(job.id) || { topic: '', summary: 'already delivered', sections: [], sources: [] };
  }
  // In-process guard: a concurrent re-entry for the same txId returns a cheap
  // placeholder instead of kicking off a second expensive research run.
  if (_inFlight.has(job.id)) return { topic: '', summary: 'in progress', sections: [], sources: [] };
  _inFlight.add(job.id);
  try {
    return await _runBrief(job, ctx);
  } finally {
    _inFlight.delete(job.id);
  }
}

async function _runBrief(job, ctx) {
  // ctx.progress(percent, message) streams progress back through the SDK so the
  // buyer (and any dashboard) can watch the job advance.
  ctx.progress(10, 'Parsing intel-brief request...');

  // Normalize input: accept a bare string or a structured object.
  const input = typeof job.input === 'string' ? { topic: job.input } : (job.input || {});
  let { topic, scope: topicScope, audience: topicAudience } = input;
  let replyTo = null;

  // IMPORTANT ACTP DETAIL: SDK 4.x does NOT transport job.input on-chain — the
  // on-chain serviceDescription is only a bytes32 routing hash. So the real
  // topic AND the reply address ride over email instead: the buyer emails
  // "[ACTP-REQUEST] <txId>" containing the topic, which we correlate back to the
  // on-chain job by its txId. We REQUIRE both fields — a brief with no recipient
  // (or a fabricated default topic) would mean the buyer paid for nothing. If
  // the request email hasn't arrived yet, we THROW so the SDK retries on a later
  // sweep (it will have arrived by then) instead of marking the job DELIVERED
  // with no real delivery.
  if (!topic || !replyTo) {
    const fromInbox = await fetchTopic(job.id).catch(() => null);
    if (fromInbox && fromInbox.topic && fromInbox.replyTo) {
      topic = topic || fromInbox.topic;
      topicScope = topicScope || fromInbox.scope;
      topicAudience = topicAudience || fromInbox.audience;
      replyTo = fromInbox.replyTo;
    }
  }
  if (!topic || !replyTo) {
    throw new Error(`intel-brief ${String(job.id).slice(0, 10)}: no correlated [ACTP-REQUEST] topic+replyTo yet — deferring for SDK retry`);
  }

  console.log(`[Oracle] job ${String(job.id).slice(0, 12)}… → topic="${topic.slice(0, 60)}" → ${replyTo}`);

  // Generate once; a delivery-only retry reuses the cached brief so we never
  // re-pay the ~100s of Claude research time for a job we already researched.
  let brief = _generated.get(job.id);
  if (!brief) {
    ctx.progress(40, `Researching: ${topic}`);
    const generated = await generateBrief({ topic, scope: topicScope, audience: topicAudience });
    brief = {
      topic,
      scope: topicScope ?? null,
      audience: topicAudience ?? null,
      summary: generated.summary,
      sections: generated.sections,
      sources: generated.sources,
      generatedAt: new Date().toISOString(),
    };
    _generated.set(job.id, brief);
  }

  // Delivery is a HARD precondition of job success: deliverBrief THROWS on a
  // send failure, so a failed email propagates out of this handler → the SDK
  // does NOT mark the job DELIVERED → the next sweep retries and actually
  // delivers BEFORE any on-chain settlement releases the escrow. This is the
  // safety interlock that ties "buyer received the goods" to "seller gets paid".
  ctx.progress(95, `Delivering brief to ${replyTo}`);
  await deliverBrief({ to: replyTo, txId: job.id, topic, brief });
  markDelivered(job.id, topic); // durable: never re-deliver / re-pay
  console.log(`[Oracle] brief delivered → ${replyTo} (tx ${String(job.id).slice(0, 10)}…)`);

  ctx.progress(100, 'Brief ready.');
  return brief;
}

// ── Agent bootstrap ─────────────────────────────────────────────────────────

async function main() {
  // The Agent wraps the ACTP runtime: wallet/keystore resolution, the on-chain
  // event poller, the escrow state machine, and the job dispatcher. `network`
  // selects which deployed contracts to use; the SDK resolves their addresses
  // internally via getNetwork(), so we don't hardcode any contract addresses.
  const agent = new Agent({
    name: 'Oracle',
    network: NETWORK,
    behavior: {
      concurrency: CONCURRENCY,
    },
  });

  // Register our single capability: intel-brief. The SDK matches by exact
  // string — a requester's request('intel-brief') routes to this provide(
  // 'intel-brief') handler. filter.minBudget enforces the $8 floor on-protocol;
  // finer-grained negotiation within $8–$12 is brokered off-protocol via the
  // AGIRAILS negotiation engine (see startNegotiator below).
  agent.provide('intel-brief', intelBrief, {
    filter: { minBudget: PRICE.floor },
  });

  // Fired by the SDK when escrow settles and USDC lands in our wallet.
  agent.on('payment:received', (amount) => {
    console.log(`[Oracle] Earned ${amount} USDC`);
  });

  // Boot the runtime: connects to the RPC, resumes any in-flight jobs, and
  // starts listening for new escrow events.
  await agent.start();

  // Off-chain price negotiation: answer buyers' [ACTP-NEGOTIATE] handshakes from
  // Oracle's $8–$12 band. The agreed price is what the buyer then escrows.
  startNegotiator({ price: { floor: PRICE.floor, base: PRICE.base, ceiling: PRICE.ceiling } });
  console.log('[Oracle] Negotiator live — answering [ACTP-NEGOTIATE] over AgentMail.');

  console.log('[Oracle] Live on AGIRAILS (' + NETWORK + ').');
  // Oracle's own on-chain wallet address (the Smart Wallet escrow settles into).
  // SANITIZED: read from the environment instead of hardcoding a real address.
  // Set ORACLE_WALLET in your .env to print it in this startup banner. This is
  // display-only — the SDK resolves the actual signing wallet from your
  // keystore/private key independently, so leaving it unset is harmless.
  if (process.env.ORACLE_WALLET) {
    console.log('[Oracle] Smart Wallet: ' + process.env.ORACLE_WALLET);
  }
  console.log('[Oracle] Service: intel-brief @ $' + PRICE.base + ' (negotiable $' + PRICE.floor + '–$' + PRICE.ceiling + ')');
  console.log('[Oracle] Concurrency: ' + CONCURRENCY + ' | Waiting for jobs... (Ctrl+C to stop)');
}

main().catch(console.error);
