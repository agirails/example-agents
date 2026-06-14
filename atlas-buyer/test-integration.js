// =============================================================================
// Atlas (buyer agent) — LIVE END-TO-END INTEGRATION TEST
// =============================================================================
// Unlike test-unit.js (which is hermetic and free), this test drives the REAL
// hardened money path against a LIVE provider/Oracle counterparty. It exercises
// the full ACTP escrow lifecycle from price discovery all the way to a settled,
// on-chain-verifiable receipt:
//
//     negotiate  →  held escrow  →  Oracle delivery  →  on-chain settle  →  receipt
//
// It spends real testnet USDC (~$9, which is actually settled to the Oracle) and
// takes ~2-3 minutes because it waits on real block confirmations and a real
// counterparty doing real work. Every stage is asserted, so this doubles as a
// smoke test for the whole buyer pipeline.
//
//   Run with:  node test-integration.js   (exits non-zero on any failure — CI-friendly)
//
// WHERE THIS SITS IN THE ACTP LIFECYCLE
// -------------------------------------
// ACTP (the Agent Commerce Transaction Protocol) settles a job through an 8-state
// escrow machine: INITIATED → QUOTED → COMMITTED → IN_PROGRESS → DELIVERED →
// SETTLED (with CANCELLED / DISPUTED branches). This test walks a transaction
// through the happy path of that machine end to end:
//   • negotiate() agrees a price off-chain          (price discovery, no funds move)
//   • escrowHold() locks USDC and the Oracle works  (→ COMMITTED → IN_PROGRESS → DELIVERED)
//   • settle() releases the held funds on-chain      (→ SETTLED, verified by the chain)
//   • the public /verify endpoint re-checks the tx   (anyone can audit the settlement)
// =============================================================================

// `dotenv` loads the local `.env` into process.env (RPC URL, AgentMail key, Oracle
// inbox, signer key, etc.). `quiet: true` suppresses the "tip" banner so it doesn't
// pollute agent logs. See `.env.example` for the full schema this test depends on.
require('dotenv').config({ quiet: true });

// The two modules under test. `negotiate` does the off-chain price handshake over
// AgentMail; `escrow` owns the on-chain money path (escrowHold = lock + wait for
// delivery, settle = release the held funds and mint the receipt).
const { negotiate } = require('./negotiate');
const { escrowHold, settle } = require('./escrow');

// ---------------------------------------------------------------------------
// Tiny test harness: a global failure counter plus an `ok()` assertion that
// prints a checkmark (or cross) per stage. `extra` is an optional human-readable
// detail (e.g. the actual price or tx hash) so the log explains *why* it passed.
// No framework dependency — keeps the template self-contained.
// ---------------------------------------------------------------------------
let fail = 0;
const ok = (name, cond, extra) => { if (cond) console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); } };

// Top-level async IIFE so we can use `await` for each lifecycle stage in order.
// A trailing `.catch()` (bottom of file) turns any unexpected throw into a clean
// non-zero exit instead of an unhandled-rejection stack trace.
(async () => {
  // The "job" Atlas is buying: a concise research brief. The topic is arbitrary —
  // it just needs to be something the Oracle counterparty knows how to deliver.
  const topic = 'Concise comparison of Coinbase x402 vs AGIRAILS ACTP for AI-agent payments — settlement, escrow, trust assumptions.';
  // Atlas's spending ceiling for this job, in USDC. negotiate() must land at or
  // below this; escrow will only ever lock up to the agreed (≤ budget) price.
  const budget = 10;

  // --- STAGE 1: NEGOTIATE (off-chain price discovery) ----------------------
  // Atlas haggles with the Oracle over AgentMail (plain-text agent↔agent email).
  // No funds move yet — this only produces the price that the escrow will lock.
  // `onState` is a progress callback so we can watch the negotiation rounds live.
  console.log('=== 1) negotiate ===');
  const neg = await negotiate({ topic, maxBudget: budget, onState: (s) => console.log('   neg:', s) });
  // The agreed price must respect the budget (never overpay) and sit at/above the
  // provider's known floor of $8 (a sane lower bound — a $0 result would mean the
  // negotiation logic broke rather than that we struck a great deal).
  ok('price ≤ budget', neg.price <= budget, `$${neg.price}`);
  ok('price ≥ floor (8)', neg.price >= 8, `$${neg.price}`);

  // --- STAGE 2: ESCROW HOLD → ORACLE DELIVERS ------------------------------
  // Here real money moves. escrowHold() drives the on-chain state machine through
  // COMMITTED (USDC locked in the EscrowVault) → IN_PROGRESS (Oracle picked up the
  // job) → DELIVERED (Oracle returned the brief and tagged it with the escrow tx).
  // `onState` logs each transition plus a truncated tx hash so progress is visible.
  console.log('=== 2) escrowHold → Oracle delivers ===');
  const r = await escrowHold({ topic, price: neg.price, onState: (s, tx) => console.log('   state:', s, tx ? tx.slice(0, 12) + '…' : '') });
  // The transaction must reach DELIVERED — anything else means the Oracle didn't
  // complete, and we abort before paying out (see the guard below).
  ok('reached DELIVERED', r.state === 'DELIVERED', `state=${r.state}`);
  // Integrity checks on the delivered brief: it exists, its txId is bound to the
  // exact escrow we funded (so a stray/old delivery can't be accepted), it carries
  // a real summary (length > 40 rules out an empty/placeholder body), and it has at
  // least one structured section. `refunded === false` confirms this is a genuine
  // delivery, not the auto-refund path that fires when an Oracle fails to deliver.
  ok('brief present', !!r.brief);
  ok('brief.txId matches escrow tx', r.brief && r.brief.txId === r.txId);
  ok('brief has a real summary', r.brief && (r.brief.summary || '').length > 40);
  ok('brief has sections', r.brief && (r.brief.sections || []).length >= 1, `${r.brief && (r.brief.sections || []).length} sections`);
  ok('not refunded (delivered)', r.refunded === false);

  // Hard gate: if there was no delivery, there is nothing to settle. Abort with a
  // non-zero exit BEFORE the settle stage so we never release funds for no work.
  if (r.state !== 'DELIVERED') { console.log(`\n=== INTEGRATION: ABORT (no delivery) — ${fail} failures ===`); process.exit(1); }

  // --- STAGE 3: SETTLE (release held funds, verified on-chain) -------------
  // settle() moves the escrow from DELIVERED → SETTLED on-chain, paying the Oracle
  // the agreed amount. We pass durationMs so the receipt can record how long the
  // job actually took. A "branded receipt" URL is minted as a shareable, public
  // proof-of-payment artifact.
  console.log('=== 3) settle (verified on-chain) + receipt ===');
  const s = await settle(r.txId, r.amount, r.durationMs);
  ok('settle ok', s.ok === true, `state=${s.state}`);
  ok('on-chain SETTLED', s.state === 'SETTLED');
  ok('branded receipt minted', !!s.receiptUrl, s.receiptUrl || 'NONE');

  // --- STAGE 4: PUBLIC RECEIPT VERIFICATION --------------------------------
  // The receipt isn't trustworthy just because *we* say so — it must be independently
  // checkable. We extract the receipt id (the r_… token) from the URL and hit the
  // PUBLIC /verify endpoint, which re-reads the settlement straight from the chain.
  // This is the "trustless" test: any third party can run the same check.
  console.log('=== 4) receipt verifies on-chain (public /verify) ===');
  if (s.receiptUrl) {
    // Receipt ids look like `r_<base36>`; pull the first match out of the URL.
    const id = (s.receiptUrl.match(/r_[a-z0-9]+/) || [])[0];
    let v = null;
    // The receipt indexer may lag the on-chain settlement by a few seconds, so we
    // poll up to 3 times with a 4s backoff, breaking as soon as it reports verified.
    for (let i = 0; i < 3; i++) {
      // Public, unauthenticated verification endpoint — note there is no secret here:
      // the receipt id alone is enough for anyone to audit the payment on-chain.
      const res = await fetch(`https://agirails.app/api/v1/receipts/${id}/verify`).catch(() => null);
      v = res ? await res.json().catch(() => null) : null;
      if (v && v.verified) break;
      await new Promise((r2) => setTimeout(r2, 4000)); // wait before the next poll
    }
    // Pass condition: the public endpoint independently confirms verified:true.
    // The `extra` surfaces either a failure reason or the confirming tx hash.
    ok('public /verify → verified:true', v && v.verified === true, v ? (v.reason || (v.onchain ? 'tx ' + v.onchain.txHash.slice(0, 12) + '…' : 'ok')) : 'no response');
  }

  // Final tally. Exit non-zero if anything failed so CI / shell wrappers can react.
  console.log(`\n=== INTEGRATION: ${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'} (tx ${r.txId.slice(0, 14)}…, paid $${r.amount}) ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('INTEGRATION THREW:', e.message); process.exit(1); });
