// ============================================================================
// Oracle's "brain" — the part that actually produces the deliverable.
// ============================================================================
//
// WHAT THIS IS
//   Oracle is an example ACTP *provider* agent: it sells "intel briefs" and gets
//   paid in USDC through ACTP escrow. This file is the brain — given a topic, it
//   asks Claude to write the brief and returns structured JSON. It knows nothing
//   about payments, email, or the protocol; that wiring lives in agent.js.
//
// WHY IT'S A SEPARATE MODULE (separation of concerns)
//   Keeping generation isolated from the ACTP/email plumbing means you can:
//     - unit-test brief generation standalone (no wallet, no inbox, no chain),
//     - swap the model or even the whole LLM backend without touching escrow
//       logic, and
//     - reason about the protocol state machine without the prompt noise.
//   The only contract with the rest of the agent is the exported `generateBrief`.
//
// HOW IT TALKS TO THE MODEL (transport)
//   Instead of an Anthropic API key, this calls the Claude Code CLI in headless
//   "print" mode (`claude -p`). That reuses the machine's existing Claude OAuth
//   session, so there is no API key to store or leak — a nice property for a
//   public template. We shell out with execFile (NOT a shell string), which
//   avoids shell-injection: the topic/scope/audience are passed as argv, never
//   interpolated into a command line.
//
// WHERE THIS SITS IN THE ACTP ESCROW LIFECYCLE
//   A job flows: COMMITTED (requester funded escrow) -> IN_PROGRESS (provider
//   accepted) -> DELIVERED (provider submits work) -> SETTLED (funds released).
//   `generateBrief` is what the provider runs during IN_PROGRESS to produce the
//   thing it will DELIVER. It THROWS on failure on purpose: agent.js lets that
//   bubble into the SDK's bounded-retry path, and if it still can't deliver, the
//   job can be cancelled/disputed rather than settling on a broken brief.
//
// SANITIZATION NOTE (public template)
//   No secrets live here. The only host-specific knobs are read from env with
//   safe defaults, so the file is publishable as-is.
// ============================================================================

// Node built-ins. We use execFile (not exec) so arguments are passed as an argv
// array — no shell, no string interpolation, no injection surface.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

// promisify -> lets us `await execFileP(...)` instead of juggling callbacks.
const execFileP = promisify(execFile);

// The Claude Code binary to invoke. Defaults to `claude` on your PATH, which is
// the normal case. Override CLAUDE_BIN only if Claude isn't on PATH or you launch
// it via a wrapper (e.g. a non-PATH launcher or a pinned version path).
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Which model writes the brief. Sonnet is a good speed/quality default for this
// kind of bounded research task; override with ORACLE_BRAIN_MODEL if you want a
// different tier.
const BRAIN_MODEL = process.env.ORACLE_BRAIN_MODEL || 'claude-sonnet-4-6';

// --- Domain grounding -------------------------------------------------------
// Why this exists: an LLM's *pretrained* knowledge of a young/niche project like
// AGIRAILS is thin and sometimes flat-out wrong (a classic mistake: claiming
// escrow "depends on the platform" — it does NOT; escrow is a non-custodial
// smart contract, EscrowVault, that holds funds with no company in the loop).
//
// The fix: keep a small, hand-checked knowledge base on disk and, whenever the
// requested topic actually touches AGIRAILS/ACTP, inject that KB into the prompt
// as AUTHORITATIVE ground truth that overrides the model's own assumptions. This
// is cheap, transparent (you can read exactly what the agent "knows"), and keeps
// the model honest without fine-tuning.

// Path to the KB. It lives next to this file under ./knowledge/ so the template
// stays self-contained. Drop your own facts file here to ground a different domain.
const AGIRAILS_KB_PATH = path.join(__dirname, 'knowledge', 'agirails-actp.md');

// Lazy + cached read: we don't read the file until the first AGIRAILS topic, and
// we read it at most once per process. `null` = "not yet attempted"; `''` = "tried
// and it was missing/unreadable" (so we don't retry the filesystem every call).
let _agirailsKB = null;
function loadAgirailsKB() {
  if (_agirailsKB === null) {
    try { _agirailsKB = fs.readFileSync(AGIRAILS_KB_PATH, 'utf8'); }
    catch { _agirailsKB = ''; }
  }
  return _agirailsKB;
}

// Cheap relevance gate: only inject the KB when the topic plausibly concerns the
// domain, so unrelated briefs (e.g. "macro outlook for Q3") don't get a wall of
// irrelevant protocol context. Word-boundary, case-insensitive match across a few
// signal terms (agirails, actp, escrowvault, {slug}.md, x402, agentregistry,
// aip-N, base l2).
const AGIRAILS_RX = /\b(agirails|actp|escrowvault|\{slug\}\.md|x402|agentregistry|aip-\d|base\s*l2)\b/i;
function topicNeedsAgirailsGrounding(...parts) {
  // Join the non-empty inputs (topic/scope/audience) and test them as one string.
  return AGIRAILS_RX.test(parts.filter(Boolean).join(' '));
}

// JSON Schema for the model's output. Passing this to `claude --json-schema`
// constrains the model to emit exactly this shape, so the caller gets a reliable
// { summary, sections, sources } object instead of free-form prose it has to parse.
//   - summary:  one-paragraph executive summary (required)
//   - sections: array of { title, body } (required) — the body of the brief
//   - sources:  named sources, or the literal "inference" where unverified
// additionalProperties:false keeps the model from smuggling in extra keys.
const BRIEF_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'sections'],
  properties: {
    summary: { type: 'string', description: 'one-paragraph executive summary' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body'],
        properties: { title: { type: 'string' }, body: { type: 'string' } },
      },
    },
    sources: { type: 'array', items: { type: 'string' }, description: 'named sources, or "inference" where unverified' },
  },
});

/**
 * Produce an intel brief on `topic` using Claude via the existing OAuth session
 * (no API key — `claude -p`). Returns { summary, sections:[{title,body}], sources:[] }.
 *
 * Throws on failure on purpose: in the provider flow this runs during the ACTP
 * IN_PROGRESS state, and a thrown error lets the SDK's bounded retry / dispute
 * path handle it (retry, then cancel/dispute) rather than DELIVERING garbage.
 *
 * @param {object}  args
 * @param {string}  args.topic     - required; what the brief is about
 * @param {string} [args.scope]    - optional focus/constraint to narrow the brief
 * @param {string} [args.audience] - optional reader, tunes depth/tone
 */
async function generateBrief({ topic, scope, audience } = {}) {
  // Guard: no topic, no brief. Fail fast and loud before spending a model call.
  if (!topic) throw new Error('generateBrief requires a topic');

  // System prompt = Oracle's persona and quality bar. The "one page" framing is
  // deliberate: it pushes the model toward signal over padding, which is what an
  // intel brief buyer is actually paying for.
  const system =
    'You are Oracle, a research agent on AGIRAILS that delivers concise, sourced intel briefs. ' +
    'Be precise and useful for a decision: map the landscape, surface the few things that actually ' +
    'matter, separate fact from inference, mark uncertainty plainly, and do not pad. One page.';

  // Decide whether to inject the AGIRAILS KB for THIS request.
  const useKB = topicNeedsAgirailsGrounding(topic, scope, audience);
  if (useKB && !loadAgirailsKB()) {
    // We wanted to ground but the KB file is missing/empty. That's the exact
    // situation that would let the model fall back to its known-wrong beliefs,
    // so we warn loudly instead of silently shipping a possibly-inaccurate brief.
    console.warn(`[Oracle] WARNING: AGIRAILS topic but KB (${AGIRAILS_KB_PATH}) is missing/empty — brief may be inaccurate.`);
  }

  // Build the grounding block only when we both want it AND actually have content.
  // The phrasing explicitly tells the model this KB OVERRIDES its prior beliefs —
  // ordering/priority instructions like this matter for getting the model to defer.
  const grounding = useKB && loadAgirailsKB()
    ? '\n\n--- AUTHORITATIVE GROUND TRUTH (AGIRAILS/ACTP) ---\n' +
      'The following facts are canonical and OVERRIDE any prior/pretrained belief you have ' +
      'about AGIRAILS or ACTP. If your general knowledge conflicts with this, this wins. ' +
      'In particular: AGIRAILS is permissionless public infrastructure and escrow is a ' +
      'non-custodial smart contract (EscrowVault) — it does NOT depend on any company/platform.\n\n' +
      loadAgirailsKB() +
      '\n--- END GROUND TRUTH ---\n'
    : '';

  // User prompt = the actual request. scope/audience are appended only if given,
  // then the grounding block, then explicit output shaping (3-5 sections, mark
  // inference). This mirrors the JSON schema we enforce below.
  const user =
    `Produce an intel brief.\nTopic: ${topic}` +
    (scope ? `\nScope / focus: ${scope}` : '') +
    (audience ? `\nAudience: ${audience}` : '') +
    grounding +
    '\n\nReturn a short summary plus 3-5 focused sections (each 2-4 sentences) that earn their place. ' +
    'List sources where you can; mark unverified claims as inference.';

  // Invoke Claude Code headless. Flag-by-flag:
  //   -p                                    print/headless mode (one-shot, no REPL)
  //   --output-format json                  wrap the result in a JSON envelope we can parse
  //   --model <BRAIN_MODEL>                  pick the generating model
  //   --system-prompt <system>              Oracle's persona/quality bar (above)
  //   --exclude-dynamic-system-prompt-sections
  //                                          strip the host's default CC system prompt so the
  //                                          brief isn't colored by local project context
  //   --setting-sources ''                  ignore local settings/CLAUDE.md etc. — deterministic,
  //                                          sandboxed generation regardless of where it runs
  //   --allowedTools ''                     no tools: pure text generation, the model can't read
  //                                          files, run commands, or touch the network/host
  //   --json-schema <BRIEF_SCHEMA>          force the structured { summary, sections, sources } shape
  //   user                                  the request itself (final positional arg)
  //
  // Process options:
  //   cwd: '/tmp'                  run in a throwaway dir; combined with the flags above this keeps
  //                                generation hermetic (no accidental project context, no writes home)
  //   maxBuffer: 16MB              briefs are small, but give headroom so a large reply isn't truncated
  //   timeout: 300000 (5 min)      hard cap so a hung model call can't block the job forever
  const { stdout } = await execFileP(CLAUDE_BIN, [
    '-p', '--output-format', 'json', '--model', BRAIN_MODEL,
    '--system-prompt', system,
    '--exclude-dynamic-system-prompt-sections',
    '--setting-sources', '', '--allowedTools', '',
    '--json-schema', BRIEF_SCHEMA,
    user,
  ], { cwd: '/tmp', maxBuffer: 16 * 1024 * 1024, timeout: 300000 });

  // The CLI prints a JSON envelope. With --json-schema, the validated brief lands
  // in `structured_output`; `result` holds the raw text fallback we use for errors.
  const data = JSON.parse(stdout);
  const out = data && data.structured_output;
  if (!out || !out.summary) {
    // No usable structured output -> throw so the caller's retry/dispute path
    // engages. We surface a slice of `result` to aid debugging without dumping
    // a giant payload into logs.
    throw new Error('brain returned no structured_output: ' + String((data && data.result) || '').slice(0, 200));
  }

  // Defensive normalization: coerce summary to a string and default the arrays so
  // the caller never has to null-check. This is the deliverable agent.js will send
  // to the requester and that backs the DELIVERED -> SETTLED transition.
  return {
    summary: String(out.summary),
    sections: Array.isArray(out.sections) ? out.sections : [],
    sources: Array.isArray(out.sources) ? out.sources : [],
  };
}

// Single, narrow public surface: the rest of the agent only needs generateBrief.
module.exports = { generateBrief };
