#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Atlas (buyer) + Oracle (provider) health probe.
#
# WHY THIS EXISTS:
# The two failure modes that actually bite an always-on agent pair are SILENT —
# nothing crashes loudly, the process just stops being useful:
#   1. A runner that died    → the node process is gone, no new work is picked up.
#   2. A "running" agent whose `claude` CLI is Not-logged-in → the process is up
#      and looks healthy, but every brain call fails auth, so it answers nothing.
# This script catches both. It REPORTS ONLY — it does not restart anything (the
# runners already self-heal). Exit 0 = all green; exit 1 = something is degraded,
# which makes it safe to wire into cron / a monitor that alerts on non-zero exit.
# ─────────────────────────────────────────────────────────────────────────────

# Directories of the two agents we probe.
# Genericized for the public template: these default to the conventional layout
# (this repo = Atlas, sibling repo = Oracle) but are overridable via env so you
# can point the probe at wherever you actually deployed each agent.
#   ATLAS_DIR  : the buyer agent's working dir (where its .pid file lives).
#   ORACLE_DIR : the provider agent's working dir (the counterparty you buy from).
ATLAS_DIR="${ATLAS_DIR:-$(cd "$(dirname "$0")" && pwd)}"   # defaults to this script's own dir
ORACLE_DIR="${ORACLE_DIR:-../agirails-oracle}"             # defaults to a sibling checkout

# Which Claude CLI binary to invoke. Defaults to `claude` on the system PATH —
# same convention the brain uses (see brain.js: CLAUDE_BIN). Override CLAUDE only
# if your installer doesn't put `claude` on PATH (e.g. an absolute path):
#   CLAUDE=/opt/anthropic/bin/claude ./healthcheck.sh
CLAUDE="${CLAUDE:-claude}"

# Aggregate failure flag. Any failing check flips this to 1; we exit with it at
# the end so callers can branch on success/failure.
fail=0

# alive() — verify a runner process is actually running.
# Args: $1 = path to the runner's pidfile, $2 = human label for the report.
# How it works: read the PID written to the pidfile, then `kill -0 <pid>` — that
# sends NO signal, it just checks "does a process with this PID exist and can I
# signal it?". If the pidfile is missing or the PID is dead, we mark a failure.
alive() { # pidfile label
  if [ -f "$1" ] && kill -0 "$(cat "$1" 2>/dev/null)" 2>/dev/null; then
    echo "  ✓ $2 runner alive (pid $(cat "$1"))"
  else
    echo "  ✗ $2 runner DOWN"; fail=1
  fi
}

# claude_ok() — verify the Claude CLI is authenticated and answering.
# Args: $1 = human label for the report.
# This is the check for the "running but Not-logged-in" silent failure. We do a
# minimal, tool-less `claude -p` ping (same headless JSON invocation the brain
# uses in brain.js) and parse the result:
#   --output-format json   : machine-readable envelope with an is_error flag.
#   --setting-sources ''   : ignore any project/user CLAUDE.md / settings, so the
#                            probe behaves identically regardless of where it runs.
#   --allowedTools ''      : no tools — we only want to know if the model answers.
#   --system-prompt ...    : keep the reply tiny and cheap.
# We run it under `zsh -lic` so the login shell sets up PATH/env exactly like the
# runner sees it (important when CLAUDE is resolved from PATH). The node one-liner
# reads stdin, parses the JSON, and emits a compact status token:
#   "OK"        → is_error false (authed and answering)
#   "ERR:..."   → is_error true (e.g. auth failure), with a truncated message
#   "PARSEFAIL" → output wasn't valid JSON at all (CLI broken / not installed)
claude_ok() { # label
  local r
  r=$(/bin/zsh -lic "$CLAUDE -p --output-format json --model claude-sonnet-4-6 --setting-sources '' --allowedTools '' --system-prompt 'Reply briefly.' 'ping'" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.is_error?"ERR:"+String(j.result).slice(0,40):"OK")}catch(e){process.stdout.write("PARSEFAIL")}})')
  if [ "$r" = "OK" ]; then echo "  ✓ $1 claude authed"; else echo "  ✗ $1 claude FAIL ($r)"; fail=1; fi
}

# ── Run the probe ────────────────────────────────────────────────────────────
echo "=== AGENT HEALTH $(date -u +%FT%TZ) ==="

# Each agent writes a pidfile when its runner starts; we check both.
alive "$ORACLE_DIR/.oracle-runner.pid" "Oracle"
alive "$ATLAS_DIR/.atlas-runner.pid" "Atlas"

# Sanity-list the long-lived node processes. A healthy deployment shows the brain
# loop (agent.js) and the AgentMail inbox poller (listener.js) running; this is a
# quick visual cross-check against the pidfile result above.
echo "  (one node agent.js + one node listener.js expected:)"
ps -Ao pid,comm,args | awk '$2 ~ /node/ && (/agent\.js/||/listener\.js/) {print "    pid",$1,$3,$4}'

# Finally, confirm the Claude CLI itself is authed and answering.
claude_ok "claude-CLI"

# Single-line verdict, then exit with the aggregate flag so monitors can alert
# on a non-zero exit code.
[ "$fail" = 0 ] && echo "ALL GREEN" || echo "DEGRADED — see ✗ above"
exit $fail
