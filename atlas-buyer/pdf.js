// =============================================================================
// pdf.js — Intel Brief renderer for the Atlas (buyer) agent
// =============================================================================
//
// WHAT THIS IS
// ------------
// A single pure-JS function, `renderBriefPdf(...)`, that turns a structured
// "intel brief" object into a clean, printable PDF and hands it back as an
// in-memory Buffer (a Promise<Buffer>).
//
// WHY pdfkit (and NOT a headless browser)
// ---------------------------------------
// We use `pdfkit` deliberately: it draws PDFs primitively (text, fonts, colors)
// with zero native dependencies and no Chromium/Puppeteer install. That keeps
// the agent lightweight enough to run inside small containers and CI, and avoids
// the security surface + cold-start cost of spawning a headless browser just to
// "print to PDF". The trade-off is that we lay out the page by hand below.
//
// WHERE THIS FITS IN THE AGENT (the email-transport + escrow story)
// -----------------------------------------------------------------
// Atlas is a *buyer* agent: it commissions an intel brief from a *provider*
// (here, "Oracle") and pays for it over ACTP escrow on Base. The flow is:
//
//   1. Atlas opens an ACTP transaction and funds escrow (USDC) for the brief.
//      -> txId below is that on-chain transaction id; it's stamped onto the
//         PDF as a tamper-evident receipt line so the buyer can tie the
//         document back to the exact payment that produced it.
//   2. The provider does the research and returns a structured `brief`.
//   3. This module renders that brief to a PDF Buffer.
//   4. The Buffer is attached to an email and delivered via AgentMail
//      (see the transport/brain wiring in the sibling modules). AgentMail is
//      the agent's mailbox-as-an-API: the agent sends/receives real email
//      without a human inbox, which is how deliverables move between agents.
//   5. Once delivery is confirmed, the ACTP escrow lifecycle advances toward
//      DELIVERED -> SETTLED and the provider is paid out.
//
// So this file is the "render the deliverable" step that sits between the
// research result and the AgentMail send. It has no secrets, no network calls,
// and no SDK calls — it is intentionally a pure, testable transform.
//
// RETURN CONTRACT
//   renderBriefPdf({ topic, txId, brief }) -> Promise<Buffer>
//     topic : string  — headline subject of the brief
//     txId  : string  — the ACTP on-chain transaction id (shown, truncated)
//     brief : object  — { summary, sections[], sources[] } (all optional)
// =============================================================================

// pdfkit is a CommonJS module; this template uses CommonJS throughout
// (note `module.exports` at the bottom), so we `require` rather than `import`.
const PDFDocument = require('pdfkit');

// --- Brand palette ----------------------------------------------------------
// A small, fixed light-theme palette so every brief looks the same. Ochre is
// the accent (wordmark + section headers), ink is body text, mute is metadata,
// and green flags the SOURCES block. Hex literals are pure styling — not secrets.
const OCHRE = '#b8863c'; // accent: wordmark + section titles
const INK = '#1a1d1b';   // primary body text (near-black)
const MUTE = '#6b746d';  // secondary text: tx line, footer, source bullets
const GREEN = '#5a7d4a'; // SOURCES section heading

function renderBriefPdf({ topic, txId, brief }) {
  // We wrap pdfkit's stream API in a Promise so callers can simply `await` the
  // finished PDF as a Buffer. pdfkit emits the document as a stream of chunks;
  // we collect them and resolve once the stream ends.
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',   // US Letter; switch to 'A4' for metric regions
      margin: 56,       // ~0.78in margin on all sides
      // PDF document metadata (shows up in a viewer's "Properties" panel).
      info: { Title: 'Oracle — Intel Brief', Author: 'Oracle · AGIRAILS' },
    });

    // Buffer the streamed output. pdfkit never gives us one big blob; instead it
    // pushes Buffer chunks on 'data'. We concat them on 'end' to get the final
    // PDF, and reject the Promise if the document errors mid-render.
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // --- Wordmark -----------------------------------------------------------
    // Top-of-page brand line. characterSpacing tracks the letters out for a
    // masthead feel. Everything from here down is sequential layout: pdfkit
    // keeps an internal "cursor" and each `text()` call advances it downward.
    doc.fillColor(OCHRE).font('Helvetica-Bold').fontSize(11).text('ORACLE   ·   INTEL BRIEF', { characterSpacing: 2 });
    doc.moveDown(1); // add one line of vertical space

    // --- Title + transaction receipt line -----------------------------------
    // The brief's topic as the headline...
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(String(topic || ''), { lineGap: 2 });
    // ...followed by a small metadata line that anchors this PDF to the exact
    // ACTP escrow transaction that paid for it. We slice(0, 26) so the long
    // 0x… txId is shown truncated with an ellipsis (full id lives on-chain),
    // plus today's date in ISO YYYY-MM-DD form. String() guards against a
    // non-string txId.
    doc.fillColor(MUTE).font('Helvetica').fontSize(8)
      .text('tx ' + String(txId).slice(0, 26) + '…   ·   ' + new Date().toISOString().slice(0, 10));
    doc.moveDown(1);

    // --- Summary ------------------------------------------------------------
    // One italic lede paragraph. Falsy/missing summary degrades to '' so the
    // renderer never throws on a partial brief.
    doc.fillColor(INK).font('Helvetica-Oblique').fontSize(11.5).text(String(brief.summary || ''), { lineGap: 3 });
    doc.moveDown(1);

    // --- Sections -----------------------------------------------------------
    // Each section is an ochre title followed by an ink body. We iterate over
    // `brief.sections || []` so an absent array is simply skipped. String()
    // coercion keeps pdfkit happy if a field is undefined/numeric.
    for (const s of brief.sections || []) {
      doc.fillColor(OCHRE).font('Helvetica-Bold').fontSize(13).text(String(s.title || ''));
      doc.moveDown(0.2);
      doc.fillColor(INK).font('Helvetica').fontSize(10.5).text(String(s.body || ''), { lineGap: 2 });
      doc.moveDown(0.7);
    }

    // --- Sources ------------------------------------------------------------
    // A green-headed bullet list of citations. Rendered only when there's at
    // least one source, so empty briefs don't show a dangling header.
    const sources = brief.sources || [];
    if (sources.length) {
      doc.moveDown(0.4);
      doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9).text('SOURCES', { characterSpacing: 1.5 });
      doc.moveDown(0.2);
      for (const src of sources) doc.fillColor(MUTE).font('Helvetica').fontSize(9).text('•  ' + String(src), { lineGap: 1 });
    }

    // --- Footer -------------------------------------------------------------
    // A centered provenance line that states the delivery + settlement rails:
    // delivered over AgentMail (email transport), settled on Base Sepolia
    // (the public testnet — this is a public network name, safe to print).
    // For mainnet briefs, swap the network label accordingly.
    doc.moveDown(2);
    doc.fillColor(MUTE).font('Helvetica').fontSize(8)
      .text('Delivered over AgentMail · settled on Base Sepolia · AGIRAILS', { align: 'center' });

    // Finalize the document. This flushes the last chunks and triggers the
    // 'end' event above, which resolves the Promise with the complete Buffer.
    doc.end();
  });
}

module.exports = { renderBriefPdf };
