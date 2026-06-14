#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# run-atlas.sh — 24/7 supervisor for the Atlas (buyer) agent.
# ─────────────────────────────────────────────────────────────────────────────
# Atlas is an email-driven AI buyer:
#   1. It LISTENS on its own AgentMail inbox (listener.js polls for new mail).
#   2. When a human emails a work request, Atlas understands it (brain.js),
#      negotiates a price with a provider agent (negotiate.js), and locks the
#      funds in an on-chain ACTP escrow (escrow.js).
#   3. In review mode it HOLDS the escrow until the human replies "approve",
#      then releases (settles) payment to the provider on-chain.
#
# This script's ONLY job is supervision: keep listener.js alive forever. If the
# Node process ever exits (crash, OOM, transient RPC failure), we restart it with
# exponential backoff so the agent is effectively always-on.
#
# Why this matters for correctness: listener.js keeps DURABLE state in
# .atlas-state.json. On every (re)start it reconciles that state — it re-arms any
# held escrows that are still awaiting human approval, and resumes any escrow that
# the provider DELIVERED but that hasn't been settled yet. So a restart never
# strands funds: every locked escrow is either eventually settled or refunded at
# its on-chain deadline. The supervisor + the reconciler together give Atlas
# "exactly-once" behavior across crashes.

# Resolve this script's own directory so the agent runs from its project root
# regardless of where it was launched from (cron, systemd, a terminal, etc.).
# Using $0 keeps this portable — there are no hardcoded machine paths here.
DIR="$(cd "$(dirname "$0")" && pwd)" || exit 1
cd "$DIR" || exit 1
LOG="atlas.log"   # all supervisor + listener output is appended here

# --- Single-instance guard (PID lock file) -----------------------------------
# Two supervisors polling the same inbox would double-process mail and could
# double-fund escrows. The lock file holds the running supervisor's PID; if that
# process is still alive (kill -0 = "does this PID exist?"), we bail out quietly.
LOCK="$DIR/.atlas-runner.pid"
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "[runner] $(date -u +%FT%TZ) another Atlas runner ($(cat "$LOCK")) is alive; exiting" >> "$LOG"
  exit 0
fi
echo $$ > "$LOCK"                 # claim the lock with our own PID ($$)
trap 'rm -f "$LOCK"' EXIT         # always release the lock when we exit

echo "[runner] $(date -u +%FT%TZ) starting Atlas runner (pid $$)" >> "$LOG"

# --- Supervised restart loop with exponential backoff ------------------------
# backoff doubles after each crash (2s → 4s → 8s …) up to a 60s ceiling, so a
# tight crash loop doesn't hammer the CPU or the RPC/email providers. If a run
# survived at least 60s we treat it as "healthy" and reset backoff to 2s, so an
# occasional restart after a long uptime recovers instantly.
backoff=2
while true; do
  echo "[runner] $(date -u +%FT%TZ) launching listener.js" >> "$LOG"
  start=$(date +%s)

  # Launch under a LOGIN, INTERACTIVE zsh (`-lic`) on purpose:
  #   • Atlas's brain (brain.js / negotiate.js) shells out to the `claude` CLI.
  #     `claude` must be on PATH and its OAuth login lives in the user's shell
  #     profile (~/.zprofile, ~/.zshrc). A login+interactive shell sources those
  #     files, so the spawned process inherits both PATH and the OAuth session.
  #   • By default `claude` is expected on PATH. If you launch from an environment
  #     where it is not on PATH (some service managers strip it), set CLAUDE_BIN
  #     to an absolute launcher path in your shell profile and have the brain read
  #     it — keeping it in the profile is exactly why we use a login shell here.
  # `exec node` replaces the shell with the Node process so signals propagate
  # cleanly and we don't leave an extra shell hanging around.
  /bin/zsh -lic "cd '$DIR' && exec node listener.js" >> "$LOG" 2>&1
  code=$?                                  # listener's exit code
  run=$(( $(date +%s) - start ))           # how long this run lasted, in seconds

  [ "$run" -ge 60 ] && backoff=2           # healthy long run → reset backoff
  echo "[runner] $(date -u +%FT%TZ) listener.js exited (code $code, ran ${run}s); restarting in ${backoff}s" >> "$LOG"
  sleep "$backoff"
  backoff=$(( backoff * 2 ))               # grow backoff for the next crash
  [ "$backoff" -gt 60 ] && backoff=60      # cap at 60s
done
