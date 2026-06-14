// ─────────────────────────────────────────────────────────────────────────────
// Atlas's commerce module — the "buyer" side of an agent-to-agent transaction.
//
// WHAT THIS DOES (the 30-second version):
//   Atlas commissions an intel brief from a provider agent ("Oracle"). It pays by
//   escrowing USDC on-chain via ACTP (the Agent Commerce Transaction Protocol),
//   ships the actual work request (the topic) to Oracle over email, then waits for
//   Oracle to deliver the finished brief back into Atlas's inbox.
//
// TWO PARALLEL CHANNELS:
//   1. MONEY / TRUST  → on-chain via the `actp` CLI (escrow + 8-state lifecycle).
//   2. WORK / PAYLOAD → off-chain via AgentMail (the topic out, the brief back).
//   The two channels are stitched together by the on-chain transaction id (txId),
//   which we embed in the email subject line so both sides agree on "which job".
//
// AUTONOMY MODE:
//   v1 is fully autonomous: `actp request` auto-settles once delivery is observed.
//   A future "Mode A" (approve-before-settle) would pause for human/agent sign-off
//   before releasing escrow — that refinement is intentionally NOT in this template.
// ─────────────────────────────────────────────────────────────────────────────

// dotenv loads secrets/config from a local .env file (see .env.example for the
// full list of variables you must set). `quiet: true` suppresses dotenv's startup
// logging so it doesn't clutter the agent's stdout.
require('dotenv').config({ quiet: true });

const { spawn } = require('node:child_process'); // used to shell out to the actp CLI
const path = require('node:path');
const { AgentMailClient } = require('agentmail'); // AgentMail = email transport for agents

// ── Configuration (ALL values come from the environment — nothing secret is baked in) ──
//
// ORACLE_ADDR: the provider agent's on-chain wallet address. Escrow is opened in
//   favour of this address; on settlement the funds release to it. REQUIRED.
const ORACLE_ADDR = process.env.ORACLE_ADDR;
// BUYER_INBOX: Atlas's own AgentMail inbox. We SEND the topic FROM here and the
//   delivered brief lands back HERE (Oracle replies to it). REQUIRED.
const BUYER_INBOX = process.env.BUYER_INBOX;
// ORACLE_INBOX: the provider agent's AgentMail inbox — the destination we send the
//   work request TO. REQUIRED.
const ORACLE_INBOX = process.env.ORACLE_INBOX_ADDR;
// RPC: JSON-RPC endpoint for Base Sepolia (testnet). A free public node is used as
//   the default so the template runs out-of-the-box; override with your own
//   (e.g. an Alchemy/Infura URL) for higher rate limits and reliability.
const RPC = process.env.BASE_SEPOLIA_RPC || 'https://base-sepolia-rpc.publicnode.com';

// Resolve the locally-installed actp CLI binary (from this package's node_modules).
// Atlas's wallet/keystore is onboarded in THIS directory, so invoking the CLI with
// cwd=__dirname makes it transact as Atlas — no private key ever appears in code.
const ACTP = path.join(__dirname, 'node_modules', '.bin', 'actp');

// AgentMail client. The API key authenticates this process to the AgentMail
// service; it is read from the environment and must never be committed.
const mail = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY });

// Tiny promise-based sleep helper, used while polling the inbox for the reply.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Commission a brief from Oracle.
 *
 * Returns { txId, amount, brief, briefText, settled, receiptUrl }.
 *   - txId       : the on-chain transaction id correlating money ↔ work.
 *   - amount     : USDC actually escrowed.
 *   - brief      : structured JSON twin of the delivered brief (machine-readable).
 *   - briefText  : the human-readable brief text.
 *   - settled    : true once escrow released (final state SETTLED observed).
 *   - receiptUrl : link to the on-chain receipt, if the CLI printed one.
 *
 * `onState(state)` is an optional callback invoked once per state as the on-chain
 * transaction walks the ACTP lifecycle (INITIATED → COMMITTED → IN_PROGRESS →
 * DELIVERED → SETTLED). Useful for driving a progress UI or the agent's "brain".
 */
function commission({ topic, budget = 10, price, onState } = {}) {
  // Escrow the negotiated price if one was agreed during quoting, otherwise fall
  // back to the buyer's budget ceiling. This is the amount locked in escrow.
  const amount = price != null ? price : budget;

  return new Promise((resolve, reject) => {
    // ── STEP 1: kick off the on-chain request via the actp CLI ──────────────────
    // `actp request <provider> <amount>` opens escrow and drives the transaction
    // through its lifecycle. Flags:
    //   --service          : the service slug being purchased ("intel-brief").
    //   --network testnet  : Base Sepolia (use "mainnet" for production USDC).
    //   --quote-timeout    : ms to wait for Oracle's price quote (90s).
    //   --delivery-timeout : ms to wait for Oracle to deliver before timing out (7m).
    // The child runs with cwd=__dirname so it uses Atlas's onboarded keystore, and
    // we forward BASE_SEPOLIA_RPC so the CLI talks to our chosen RPC endpoint.
    const child = spawn('node', [
      ACTP, 'request', ORACLE_ADDR, String(amount), '--service', 'intel-brief',
      '--network', 'testnet', '--quote-timeout', '90000', '--delivery-timeout', '420000',
    ], { cwd: __dirname, env: { ...process.env, BASE_SEPOLIA_RPC: RPC } });

    let out = '';                 // accumulated stdout from the CLI (parsed below)
    let txId = null;              // captured once the CLI prints the tx id
    const emitted = new Set();    // de-dupes onState() so each state fires only once

    // ── STEP 2: watch the CLI's stdout to (a) surface lifecycle states and
    //            (b) capture the txId so we can ship the work payload. ───────────
    child.stdout.on('data', async (d) => {
      const s = d.toString();
      out += s;

      // Surface each ACTP lifecycle state the moment it first appears in output.
      for (const st of ['INITIATED', 'COMMITTED', 'IN_PROGRESS', 'DELIVERED', 'SETTLED']) {
        if (s.includes(st) && !emitted.has(st)) { emitted.add(st); if (onState) onState(st); }
      }

      // The first 32-byte hex value the CLI prints is the transaction id. As soon
      // as we have it, we send the actual work request (the topic) to Oracle —
      // tagged with the txId so Oracle knows which on-chain job this email funds.
      if (!txId) {
        const m = out.match(/0x[0-9a-f]{64}/);
        if (m) {
          txId = m[0];
          // Send TOPIC to Oracle over AgentMail, correlated to the chain by txId.
          // Errors are swallowed (.catch) so a transient mail hiccup never crashes
          // the in-flight on-chain transaction; the delivery poll below recovers.
          await mail.inboxes.messages.send(BUYER_INBOX, {
            to: [ORACLE_INBOX], subject: `[ACTP-REQUEST] ${txId}`, text: `TOPIC: ${topic}`,
          }).catch(() => {});
        }
      }
    });

    // stderr is intentionally ignored — the CLI prints diagnostics there that we
    // don't need to act on; the close handler + stdout parsing carry the result.
    child.stderr.on('data', () => {});

    // ── STEP 3: once the CLI exits, fetch the delivered brief from the inbox ─────
    child.on('close', async () => {
      // Oracle replies to Atlas's inbox with the finished brief. We poll for it
      // (up to 24 tries × 5s ≈ 2 minutes), matching on the subject line which
      // contains "Intel brief" and the first 10 chars of our txId — that pairing
      // guarantees we pick up THIS job's reply and not some unrelated message.
      let brief = null, briefText = null;
      for (let i = 0; i < 24 && !brief; i++) {
        const l = await mail.inboxes.messages.list(BUYER_INBOX, { limit: 10 }).catch(() => null);
        const hit = (l?.messages || []).find((m) =>
          (m.subject || '').includes('Intel brief') && txId && (m.subject || '').includes(txId.slice(0, 10)));
        if (hit) {
          // Pull the full message body (the list view only has headers/preview).
          // AgentMail's id field has been seen as both messageId and message_id,
          // so we tolerate either shape.
          const full = await mail.inboxes.messages.get(BUYER_INBOX, hit.messageId || hit.message_id).catch(() => null);
          const body = String((full && full.text) || '');

          // The brief is a "dual twin": human-readable prose on top, then a
          // "--- machine-readable ---" delimiter, then a JSON object Atlas can
          // parse and re-present to its principal. Split the two halves here.
          briefText = body.replace(/\n\n--- machine-readable ---[\s\S]*$/, '').trim();
          const jm = body.match(/--- machine-readable ---\s*([\s\S]*)$/);
          if (jm) { try { brief = JSON.parse(jm[1].trim()); } catch (_) { /* malformed JSON → fall through */ } }

          // Fallback: if there was no parseable JSON twin, synthesize a minimal
          // structured object from the prose so callers always get a consistent shape.
          if (!brief && briefText) brief = { topic: '', summary: briefText, sections: [], sources: [] };
        } else {
          // Nothing yet — wait 5s and poll again.
          await sleep(5000);
        }
      }

      // ── STEP 4: resolve with the combined money + work result ─────────────────
      resolve({
        txId,
        amount,
        brief,
        briefText,
        // "settled" is true if the CLI reported a SETTLED final state in its output
        // OR we observed the SETTLED state stream by while parsing stdout.
        settled: /finalState:\s*SETTLED/.test(out) || emitted.has('SETTLED'),
        // The on-chain receipt URL, if the CLI emitted one (handy for audit/UI).
        receiptUrl: (out.match(/receiptUrl:\s*(\S+)/) || [])[1] || null,
      });
    });

    // If the child process itself fails to spawn/run, surface that as a rejection.
    child.on('error', reject);
  });
}

module.exports = { commission };
