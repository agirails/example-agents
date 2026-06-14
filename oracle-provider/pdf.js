// ---------------------------------------------------------------------------
// pdf.js — Intel-brief PDF renderer for the Oracle provider agent
// ---------------------------------------------------------------------------
//
// WHAT THIS IS
//   A tiny, dependency-light module that turns a structured "brief" object into
//   a clean, printable PDF (light theme, ochre accents). It uses `pdfkit` —
//   a pure-JavaScript PDF engine — so there is NO headless Chromium/Puppeteer
//   to install, sandbox, or keep patched. That keeps the agent lightweight and
//   easy to run anywhere (a laptop, a small VPS, a CI job).
//
// WHERE IT FITS IN THE AGENT
//   The Oracle agent is a *provider* in the ACTP economy. A requester pays into
//   on-chain escrow for an "intel brief", the agent's brain researches the
//   topic and produces a structured `brief` object, and then THIS module turns
//   that object into a Buffer of PDF bytes. The agent attaches that Buffer to
//   an AgentMail email (the delivery transport) and then marks the ACTP
//   transaction DELIVERED so the escrow can settle. So this file is the very
//   last "make it presentable" step before delivery + settlement.
//
//   Flow recap:
//     escrow funded → brain researches → renderBriefPdf() → email attachment
//       → ACTP markDelivered → settlement releases USDC to the provider.
//
// SECURITY NOTE
//   This module is pure presentation logic. It holds no keys, no inbox
//   addresses, and no RPC endpoints — those all live in the agent's config /
//   environment, never here. Safe to read top-to-bottom as a teaching example.
// ---------------------------------------------------------------------------

const PDFDocument = require('pdfkit');

// --- Brand palette --------------------------------------------------------
// A small, fixed palette keeps every brief visually consistent. Hex strings
// are passed straight to pdfkit's fillColor(). These are pure styling tokens
// (not secrets), so they stay hardcoded.
const OCHRE = '#b8863c'; // primary accent — wordmark, section headings
const INK   = '#1a1d1b'; // near-black body text
const MUTE  = '#6b746d'; // secondary/metadata text (tx id, dates, sources)
const GREEN = '#5a7d4a'; // the "SOURCES" label, a subtle credibility cue

/**
 * Render a structured intel brief into a printable PDF.
 *
 * @param {Object}   args
 * @param {string}   args.topic  - Human-readable subject line for the brief.
 * @param {string}   args.txId   - The ACTP transaction id this brief settles.
 *                                  We stamp a short prefix of it onto the page
 *                                  so the PDF is auditable back to the on-chain
 *                                  escrow that paid for it.
 * @param {Object}   args.brief  - The researched payload from the agent's brain:
 *                                  { summary, sections: [{title, body}], sources: [] }
 * @returns {Promise<Buffer>}    - Resolves to the complete PDF as a Buffer,
 *                                  ready to be attached to an AgentMail message.
 *
 * We return a Promise<Buffer> (rather than streaming to a file) because the
 * caller wants the bytes in memory to hand directly to the email transport —
 * no temp files to clean up, no disk I/O on the delivery path.
 */
function renderBriefPdf({ topic, txId, brief }) {
  return new Promise((resolve, reject) => {
    // pdfkit writes to a stream. We create the document, then collect every
    // emitted chunk and concatenate at the end into one Buffer.
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 56,
      info: { Title: 'Oracle — Intel Brief', Author: 'Oracle · AGIRAILS' },
    });

    // Buffer the streamed output. 'data' fires for each chunk pdfkit produces;
    // 'end' fires once doc.end() has flushed everything → we resolve there.
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // --- Wordmark -------------------------------------------------------
    // A small branded header so the deliverable looks like a real product,
    // not a raw data dump. characterSpacing adds the airy "tracked-out" look.
    doc.fillColor(OCHRE).font('Helvetica-Bold').fontSize(11).text('ORACLE   ·   INTEL BRIEF', { characterSpacing: 2 });
    doc.moveDown(1);

    // --- Title + transaction stamp -------------------------------------
    // The topic is the headline. Below it we print a truncated tx id and the
    // render date. The tx id ties this document to the exact ACTP escrow that
    // funded it — a lightweight provenance/audit trail. We slice to 26 chars
    // + ellipsis to keep the metadata line tidy (full id lives on-chain).
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(String(topic || ''), { lineGap: 2 });
    doc.fillColor(MUTE).font('Helvetica').fontSize(8)
      .text('tx ' + String(txId).slice(0, 26) + '…   ·   ' + new Date().toISOString().slice(0, 10));
    doc.moveDown(1);

    // --- Summary --------------------------------------------------------
    // The lede: an italicized one-paragraph TL;DR from the brain. String() +
    // `|| ''` guards against a missing field so a partial brief still renders
    // instead of throwing on the delivery path.
    doc.fillColor(INK).font('Helvetica-Oblique').fontSize(11.5).text(String(brief.summary || ''), { lineGap: 3 });
    doc.moveDown(1);

    // --- Sections -------------------------------------------------------
    // The body of the brief: an ordered list of { title, body } blocks. We
    // default to [] so a brief with no sections simply skips this loop.
    for (const s of brief.sections || []) {
      doc.fillColor(OCHRE).font('Helvetica-Bold').fontSize(13).text(String(s.title || ''));
      doc.moveDown(0.2);
      doc.fillColor(INK).font('Helvetica').fontSize(10.5).text(String(s.body || ''), { lineGap: 2 });
      doc.moveDown(0.7);
    }

    // --- Sources --------------------------------------------------------
    // Citations build trust in the deliverable. Only render the block if the
    // brain actually returned sources; each is printed as a bullet line.
    const sources = brief.sources || [];
    if (sources.length) {
      doc.moveDown(0.4);
      doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9).text('SOURCES', { characterSpacing: 1.5 });
      doc.moveDown(0.2);
      for (const src of sources) doc.fillColor(MUTE).font('Helvetica').fontSize(9).text('•  ' + String(src), { lineGap: 1 });
    }

    // --- Footer ---------------------------------------------------------
    // A one-line provenance footer: it names the delivery transport (AgentMail)
    // and the settlement network. This is documentation for the human reading
    // the PDF — the network name is public, not a secret.
    doc.moveDown(2);
    doc.fillColor(MUTE).font('Helvetica').fontSize(8)
      .text('Delivered over AgentMail · settled on Base Sepolia · AGIRAILS', { align: 'center' });

    // doc.end() flushes the stream → triggers the 'end' handler above → the
    // Promise resolves with the finished PDF Buffer.
    doc.end();
  });
}

// CommonJS export — the agent's delivery code does `require('./pdf')` and calls
// renderBriefPdf() right before attaching the result to an AgentMail message.
module.exports = { renderBriefPdf };
