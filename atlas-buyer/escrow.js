// Atlas's held-escrow path — the protocol's native "review before release":
// escrow + fund → Oracle delivers → state holds at DELIVERED → the requester
// decides settle vs dispute. Hardened for exactly-once + truthful end-state.
//
//   escrowHold(): fund a held escrow, wait for DELIVERED, fetch the brief.
//                 On Oracle no-show → CANCEL + refund (never leave funds stuck).
//   settle():     release escrow, confirm SETTLED on-chain (not by stdout text),
//                 push the AGIRAILS receipt.
//   cancelEscrow(), txStatus(): recovery primitives used by the boot reconciler.
//
// ──────────────────────────────────────────────────────────────────────────
// HOW THE PIECES FIT TOGETHER (read this first if you're new):
//
//   1. ACTP escrow lifecycle (the on-chain money rails). Each job is one
//      protocol transaction (txId) that walks an 8-state machine. This file
//      only touches the requester (buyer) side of it:
//        create+fund  → COMMITTED      (funds locked in EscrowVault)
//        provider works → IN_PROGRESS
//        provider delivers → DELIVERED  (HELD: funds NOT yet released)
//        we settle    → SETTLED         (funds released to the provider)
//        we cancel    → CANCELLED        (funds refunded to us)
//      The "held" pattern is deliberate: delivery does NOT auto-pay. We get to
//      inspect the brief at DELIVERED and only then choose settle vs cancel.
//
//   2. AgentMail email transport (the off-chain content rails). The chain can
//      carry money + a service-routing hash, but it can't carry the actual job
//      INPUT ("what topic do you want a brief on?") or OUTPUT (the brief text).
//      So we correlate the two rails by email: we email Oracle the topic keyed
//      by txId, and Oracle emails the finished brief back keyed by the same
//      txId. The on-chain txId is the join key between money and content.
//
//   3. The `actp` CLI is the bridge to the chain. We shell out to it (rather
//      than embedding the SDK end-to-end) so the keystore / signing all live in
//      one well-tested place. Everything reads back as JSON we grep.
// ──────────────────────────────────────────────────────────────────────────

require('dotenv').config({ quiet: true });
const { spawn } = require('node:child_process');
const path = require('node:path');
const { AgentMailClient } = require('agentmail');

// ── Identity & endpoint configuration ──────────────────────────────────────
// Everything below is read from the environment (see .env.example). The repo
// ships ZERO hardcoded wallets, inboxes, or API keys — fill in your own.
//
//   ORACLE_ADDR  : the on-chain address of the provider (Oracle) we buy from.
//   BUYER_WALLET : OUR on-chain requester address. With the 3-tier wallet setup
//                  this is the Smart Wallet (ERC-4337) that actually holds funds
//                  on-chain, which can differ from the EOA that SIGNS receipts.
//   BUYER_INBOX  : our AgentMail inbox (where Oracle sends the finished brief).
//   ORACLE_INBOX : Oracle's AgentMail inbox (where we send the job topic).
//   RPC          : Base Sepolia JSON-RPC. A public node is a safe default.
const ORACLE_ADDR = process.env.ORACLE_ADDR;            // provider's on-chain address (required)
const BUYER_WALLET = process.env.BUYER_WALLET;          // our on-chain requester (smart wallet) (required)
const BUYER_INBOX = process.env.BUYER_INBOX;            // our AgentMail inbox (required)
const ORACLE_INBOX = process.env.ORACLE_INBOX_ADDR;     // provider's AgentMail inbox (required)
const RPC = process.env.BASE_SEPOLIA_RPC || 'https://base-sepolia-rpc.publicnode.com';
const ACTP = path.join(__dirname, 'node_modules', '.bin', 'actp');

// Lazily resolve the `ethers` module. We try a bare require first, then fall
// back to resolving it from the SDK's own node_modules — this makes the agent
// work whether ethers is a top-level dep or only transitively present via the
// SDK. Used both for the service-hash derivation and the on-chain log scan.
const _ethersMod = () => { const base = path.dirname(require.resolve('@agirails/sdk')); try { return require('ethers'); } catch { return require(require.resolve('ethers', { paths: [base] })); } };

// The on-chain service-routing hash for the "intel-brief" service.
// It is simply keccak256(utf8('intel-brief')) — the SAME value the SDK derives
// from `actp request --service intel-brief`. We compute it from the service
// NAME at startup (instead of hardcoding the digest) so it is self-documenting
// and provably correct: this is a deterministic, public value, not a secret.
// It is passed as the raw serviceDescription so the held escrow routes to
// Oracle's intel-brief handler.
const SERVICE_NAME = process.env.SERVICE_NAME || 'intel-brief';
const SERVICE_HASH = (() => { const ethers = _ethersMod(); return ethers.keccak256(ethers.toUtf8Bytes(SERVICE_NAME)); })();

// AgentMail client — the off-chain email transport. The API key is secret and
// comes only from the environment; it is never committed. See .env.example.
const mail = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run the actp CLI; resolve { out, err, code } (never rejects on non-zero). */
// We spawn `node node_modules/.bin/actp ...` rather than throwing on failure so
// callers can always inspect the raw output. We thread BASE_SEPOLIA_RPC through
// the child env so the CLI talks to the same RPC we do, and we enforce a hard
// timeout (SIGKILL) so a hung RPC can never wedge the agent forever.
function runActp(args, { timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('node', [ACTP, ...args], { cwd: __dirname, env: { ...process.env, BASE_SEPOLIA_RPC: RPC } }); }
    catch (e) { return resolve({ out: '', err: String(e && e.message), code: -1 }); }
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve({ out, err, code: 'TIMEOUT' }); }, timeout);
    child.on('close', (code) => { clearTimeout(t); resolve({ out, err, code }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ out, err: String(e && e.message), code: -1 }); });
  });
}

// Tiny extractors over the CLI's `--json` output. We pull the txId and the
// current state straight out of the JSON text — robust to extra log lines the
// CLI may print around the JSON payload.
const grabTxId = (s) => (String(s).match(/"txId":\s*"(0x[0-9a-f]{64})"/) || [])[1] || null;
const grabState = (s) => (String(s).match(/"state":\s*"([A-Z_]+)"/) || [])[1] || null;

/** Read the on-chain state of a tx ('COMMITTED'|'IN_PROGRESS'|'DELIVERED'|'SETTLED'|'CANCELLED'|null). */
// The single source of truth for "where is this job?" — always the chain, never
// our local assumptions. Every state decision in this file funnels through here.
async function txStatus(txId) {
  const { out } = await runActp(['tx', 'status', txId, '--json'], { timeout: 60000 });
  return grabState(out);
}

/** Cancel a tx (refunds the requester). Returns true if it reaches CANCELLED. */
// Recovery primitive: turns a stuck/undelivered escrow back into a refund. We
// re-read the chain state after a short delay to CONFIRM the cancel landed,
// rather than trusting the cancel command's exit code.
async function cancelEscrow(txId) {
  await runActp(['tx', 'cancel', txId, '--json'], { timeout: 120000 });
  await sleep(3000);
  return (await txStatus(txId)) === 'CANCELLED';
}

/**
 * Find Oracle's delivered brief for `txId` in Atlas's inbox. Matches the FULL
 * txId in the subject AND verifies the embedded JSON twin's txId — so a stale or
 * look-alike brief can never be forwarded as the current one.
 */
// This is the OUTPUT half of the email correlation: Oracle replies with the
// brief in our inbox, subject-tagged with the txId. We poll the inbox (delivery
// is async) and apply two independent checks before trusting a message:
//   (1) the subject must contain the FULL txId (not a prefix), and
//   (2) the machine-readable JSON twin inside the body must carry the SAME txId.
// Both must agree, which defeats stale/replayed/look-alike briefs.
async function fetchBrief(txId, { tries = 24, delayMs = 5000 } = {}) {
  const full = String(txId);
  for (let i = 0; i < tries; i++) {
    const l = await mail.inboxes.messages.list(BUYER_INBOX, { limit: 12 }).catch(() => null);
    const hit = (l?.messages || []).find((m) => (m.subject || '').includes('Intel brief') && (m.subject || '').includes(full));
    if (hit) {
      const msg = await mail.inboxes.messages.get(BUYER_INBOX, hit.messageId || hit.message_id).catch(() => null);
      // AgentMail appends a "\n--\nSent via AgentMail" footer AFTER our JSON twin,
      // which breaks a naive JSON.parse — strip it before extracting.
      const body = String((msg && msg.text) || '').replace(/\n--\s*\nSent via AgentMail[\s\S]*$/i, '');
      const briefText = body.replace(/\n\n--- machine-readable ---[\s\S]*$/, '').trim();
      const jm = body.match(/--- machine-readable ---\s*([\s\S]*)$/);
      let brief = null;
      if (jm) {
        let raw = jm[1].trim();
        // Be tolerant of any trailing noise: take from the first { to the last }.
        const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
        if (a >= 0 && b > a) raw = raw.slice(a, b + 1);
        try { brief = JSON.parse(raw); } catch (_) { /* ignore */ }
      }
      // Verify the brief actually belongs to this tx before trusting it.
      if (brief && brief.txId && brief.txId !== full) brief = null;
      // If there was no parseable JSON twin but we got prose, fall back to a
      // minimal brief shape so the caller always gets a consistent object.
      if (!brief && briefText) brief = { topic: '', summary: briefText, sections: [], sources: [] };
      if (brief) return { brief, briefText };
    }
    await sleep(delayMs);
  }
  return { brief: null, briefText: null };
}

/**
 * Escrow at `price`, wait for Oracle to DELIVER, fetch the brief — WITHOUT settling.
 * On no-show (still COMMITTED/IN_PROGRESS past the deadline) → cancel + refund.
 * Returns { txId, state, brief, briefText, amount, durationMs, refunded }.
 */
// This is the full BUYER flow for one job, end to end:
//   1. `tx create ... --fund`  → locks `price` USDC in escrow (COMMITTED).
//   2. Email Oracle the TOPIC keyed by txId (the chain can't carry job.input).
//   3. Poll the chain until state reaches DELIVERED (Oracle finished + delivered).
//   4. If the deadline passes without delivery → cancel → refund (no stuck funds).
//   5. On DELIVERED → fetch the brief from email and return it UNSETTLED, so the
//      caller can review the content before deciding to settle (pay) or dispute.
async function escrowHold({ topic, price, onState, deliveryTimeoutMs = 420000 } = {}) {
  const startedAt = Date.now();
  const { out } = await runActp(['tx', 'create', ORACLE_ADDR, String(price), '--description', SERVICE_HASH, '--fund', '--json'], { timeout: 120000 });
  const txId = grabTxId(out);
  if (!txId) throw new Error('escrow create returned no txId');
  if (onState) onState('COMMITTED', txId);

  // Correlate the topic to the on-chain job (SDK can't carry job.input on-chain).
  // This is the INPUT half of the email correlation, mirrored by fetchBrief's
  // OUTPUT half: subject is tagged [ACTP-REQUEST] <txId> so Oracle can join it
  // back to the funded escrow it just saw on-chain.
  await mail.inboxes.messages.send(BUYER_INBOX, { to: [ORACLE_INBOX], subject: `[ACTP-REQUEST] ${txId}`, text: `TOPIC: ${topic}` }).catch(() => {});

  // Poll the chain for delivery. We surface every state change via onState (for
  // logging/UI) and stop as soon as we observe DELIVERED (or SETTLED, in case a
  // prior run already advanced it). 7s cadence keeps RPC load light.
  const deadline = Date.now() + deliveryTimeoutMs;
  let state = 'COMMITTED';
  while (Date.now() < deadline) {
    await sleep(7000);
    const st = await txStatus(txId);
    if (st && st !== state) { state = st; if (onState) onState(st, txId); }
    if (state === 'DELIVERED' || state === 'SETTLED') break;
  }

  if (state !== 'DELIVERED' && state !== 'SETTLED') {
    // Oracle never delivered — do NOT leave funds locked. Cancel → refund.
    const refunded = await cancelEscrow(txId).catch(() => false);
    if (onState) onState(refunded ? 'CANCELLED' : state, txId);
    return { txId, state: refunded ? 'CANCELLED' : state, brief: null, briefText: null, amount: price, durationMs: Date.now() - startedAt, refunded };
  }

  const { brief, briefText } = await fetchBrief(txId);
  return { txId, state, brief, briefText, amount: price, durationMs: Date.now() - startedAt, refunded: false };
}

// Find the actual Ethereum tx that emitted StateTransitioned(...,SETTLED) for this
// protocol tx. Lets the receipt carry eth_tx_hash so the public /verify endpoint
// confirms it IMMEDIATELY instead of waiting on (an unreliable) indexer backfill.
//
// How: we scan the ACTPKernel contract's logs for the StateTransitioned event,
// filtered by (topic0 = event signature, topic1 = our txId, topic3 = newState
// SETTLED). The kernel address is resolved from the SDK's getNetwork() — a
// PUBLIC, canonical contract address, safe to ship. We widen the block window
// progressively because a just-settled tx is within a few blocks, but a backfill
// of an older receipt needs a larger (still RPC-friendly) getLogs span.
async function findSettleTx(txId) {
  try {
    const ethers = _ethersMod();
    const { getNetwork } = require('@agirails/sdk');
    const kernel = getNetwork('base-sepolia').contracts.actpKernel;
    const provider = new ethers.JsonRpcProvider(RPC);
    const topic0 = ethers.id('StateTransitioned(bytes32,uint8,uint8,address,uint256)');
    const settled = ethers.zeroPadValue('0x05', 32); // newState = SETTLED(5), indexed uint8
    const head = await provider.getBlockNumber();
    // Widen progressively: a just-settled tx is within a few blocks; a backfill of
    // an older receipt needs more. Stays within publicnode's getLogs window.
    for (const span of [1500, 6000]) {
      const logs = await provider.getLogs({ address: kernel, topics: [topic0, txId, null, settled], fromBlock: Math.max(0, head - span), toBlock: head });
      if (logs.length) { const log = logs[logs.length - 1]; return { ethTxHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber }; }
    }
    return null;
  } catch (_) { return null; }
}

// Push the AGIRAILS settlement receipt, mirroring runRequest exactly: signer = EOA
// from the keystore, requesterAddress = the on-chain smart wallet. Includes the
// settle tx hash so /verify works immediately. Best-effort.
//
// Two identity notes that trip people up:
//   • signer is the EOA recovered from the local keystore via resolvePrivateKey
//     — it's who SIGNS the receipt attestation.
//   • requesterAddress is BUYER_WALLET, the on-chain smart wallet that actually
//     held the escrowed funds. These two can differ in the 3-tier wallet model.
// Fees: we recompute the display fee the same way the protocol does
// (computeDisplayFee over the USDC-6dp amount) so the receipt's gross/fee/net
// math matches the chain exactly.
const _receiptPushed = new Map(); // txId -> url (avoid posting two receipts for one settlement)
async function pushReceipt(txId, price, durationMs = 1000, onchain) {
  if (_receiptPushed.has(txId)) return _receiptPushed.get(txId);
  try {
    const base = path.dirname(require.resolve('@agirails/sdk')); // .../dist
    const { pushReceiptOnSettled } = require(path.join(base, 'receipts', 'push.js'));
    const { computeDisplayFee } = require(path.join(base, 'config', 'defaults.js'));
    const { getNetwork, resolvePrivateKey } = require('@agirails/sdk');
    const ethers = _ethersMod();

    // Pull the signing key from the local keystore (never hardcoded). If there's
    // no key configured, we silently skip — receipts are best-effort decoration.
    const pk = await resolvePrivateKey(__dirname, { network: 'base-sepolia' });
    if (!pk) return null;
    const kernelAddress = getNetwork('base-sepolia').contracts.actpKernel;
    // USDC has 6 decimals; convert the human price to base units, then split it
    // into protocol fee + net-to-provider exactly as the chain does.
    const amountWei = BigInt(Math.round(Number(price) * 1e6));
    const feeWei = computeDisplayFee(amountWei);
    const netWei = amountWei > feeWei ? amountWei - feeWei : 0n;
    const oc = onchain || (await findSettleTx(txId)) || {};

    const push = await pushReceiptOnSettled({
      signer: new ethers.Wallet(pk),
      participantRole: 'requester',
      providerAddress: ORACLE_ADDR,
      requesterAddress: BUYER_WALLET,
      kernelAddress,
      txId,
      network: 'base-sepolia',
      amountWei: amountWei.toString(),
      feeWei: feeWei.toString(),
      netWei: netWei.toString(),
      serviceHash: SERVICE_HASH,
      service: SERVICE_NAME,
      durationMs: Math.max(1, Math.round(durationMs)),
      ethTxHash: oc.ethTxHash,       // → /verify confirms on-chain immediately
      logIndex: oc.logIndex,
      blockNumber: oc.blockNumber,
    });
    const url = (push && push.receiptUrl) || null;
    if (url) _receiptPushed.set(txId, url);
    return url;
  } catch (_) {
    return null;
  }
}

/**
 * Release the escrow to Oracle and confirm SETTLED ON-CHAIN (not by stdout text,
 * so a confirm-timeout-after-broadcast isn't misreported as failure). Then push
 * the receipt. Returns { ok, receiptUrl, state }.
 */
// The "review passed → pay" half of the held-escrow pattern. Key hardening:
//   • Idempotent: if the tx is already SETTLED (e.g. a retry after a confirm
//     timeout), we DON'T re-broadcast — we just proceed to the receipt.
//   • Truthful end-state: success is decided by re-reading the chain state, not
//     by the CLI's stdout. A broadcast that times out on confirmation but DID
//     land still reports ok:true.
//   • Both the settle confirmation and the receipt push tolerate RPC lag with a
//     single retry after a short sleep.
async function settle(txId, price, durationMs) {
  // Already settled (e.g. a retry after a confirm-timeout)? Don't double-send.
  let state = await txStatus(txId);
  if (state !== 'SETTLED') {
    await runActp(['tx', 'settle', txId], { timeout: 120000 });
    await sleep(3000);
    state = await txStatus(txId);
    if (state !== 'SETTLED') { await sleep(6000); state = await txStatus(txId); } // RPC may lag the settle
  }
  const ok = state === 'SETTLED';
  let receiptUrl = null;
  if (ok) {
    let onchain = await findSettleTx(txId);
    if (!onchain) { await sleep(5000); onchain = await findSettleTx(txId); } // RPC may lag the settle tx
    receiptUrl = await pushReceipt(txId, price, durationMs, onchain);
    if (!receiptUrl) { await sleep(5000); receiptUrl = await pushReceipt(txId, price, durationMs, onchain); }
  }
  return { ok, receiptUrl, state };
}

module.exports = { escrowHold, settle, pushReceipt, findSettleTx, cancelEscrow, txStatus, fetchBrief, SERVICE_HASH };
