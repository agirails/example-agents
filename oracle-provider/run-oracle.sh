#!/bin/bash
# =============================================================================
# Oracle 24/7 supervisor — keeps the provider agent (agent.js) alive forever.
# =============================================================================
#
# WHAT THIS IS
#   A tiny, dependency-free process supervisor for the Oracle *provider* agent.
#   The Oracle agent (agent.js) is a long-running Node process that:
#     1. polls its AgentMail inbox for incoming requests (email = transport),
#     2. quotes/commits work over ACTP (on-chain escrow on Base L2),
#     3. runs its "brain" (an LLM via the `claude` CLI) to produce the answer,
#     4. delivers the result and lets the escrow settle.
#   Because it's meant to earn 24/7, it must survive crashes, transient RPC
#   errors, and inbox hiccups. This script is the babysitter that restarts it.
#
# WHY A SHELL SCRIPT (and not pm2/systemd/launchd)
#   Zero install, runs anywhere with bash, and — crucially — it can launch the
#   agent through a *login + interactive* shell so the agent inherits the same
#   environment a human would get in a terminal. See the launch line below for
#   why that matters for the LLM brain.
#
# WHY A LOGIN+INTERACTIVE SHELL (this is the non-obvious part)
#   The agent's brain calls the `claude` CLI in headless mode (`claude -p`).
#   `claude` reads its OAuth token from the user's shell profile/keychain. A
#   plain detached launcher (cron, a bare `node agent.js`, most service
#   managers) does NOT source that profile, so `claude -p` comes up as
#   "Not logged in" → the brief generation step fails → the agent produces no
#   deliverable → nothing gets delivered and escrow never settles. Launching via
#   `zsh -lic` (login + interactive + command) forces the profile to load so the
#   token is present. This is a deliberate trade-off, not an accident.
#
# USAGE
#   ./run-oracle.sh            # foreground; logs to ./oracle.log
#   nohup ./run-oracle.sh &    # detached; survives terminal close
#
# CONFIG
#   No secrets live here. The agent reads everything it needs (AgentMail inbox,
#   RPC URL, signing key, model creds) from its own environment / .env at
#   runtime — see agent.js and .env.example. This script only manages the
#   process lifecycle.
# =============================================================================

# Resolve the directory this script lives in, regardless of where it's invoked
# from. `$0` is the script path; `dirname` strips the filename; `cd ... && pwd`
# turns it into a clean absolute path. Everything below runs relative to here so
# the agent always finds its sibling files (agent.js, .env, oracle.log).
DIR="$(cd "$(dirname "$0")" && pwd)" || exit 1
cd "$DIR" || exit 1
LOG="oracle.log"   # all supervisor + agent output is appended here

# --- single-instance guard (portable PID file; macOS has no util-linux flock) ---
# Two runners would mean two agents polling the same inbox → double-quoting,
# double-charging, racing on the same ACTP transactions. We must guarantee only
# one is ever alive. flock(1) isn't available on stock macOS, so we use a simple
# PID-file lock that works the same on macOS and Linux:
#   - LOCK holds the PID of the running runner.
#   - `kill -0 <pid>` sends no signal; it just tests "is this PID alive?".
#   - If the file exists AND that PID is alive, another runner owns the lock →
#     we log and exit cleanly (exit 0, so a relaunch attempt is a harmless no-op).
LOCK="$DIR/.oracle-runner.pid"
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "[runner] $(date -u +%FT%TZ) another Oracle runner ($(cat "$LOCK")) is alive; exiting" >> "$LOG"
  exit 0
fi
echo $$ > "$LOCK"               # claim the lock by writing our own PID ($$)
trap 'rm -f "$LOCK"' EXIT       # always release the lock when this script exits

echo "[runner] $(date -u +%FT%TZ) starting Oracle runner (pid $$)" >> "$LOG"

# --- crash-restart loop with exponential backoff ---
# The agent should run forever. If it exits for any reason, we restart it. To
# avoid hammering the CPU (and the RPC/inbox/LLM endpoints) when the agent is
# crash-looping on startup, we back off exponentially: 2s, 4s, 8s, ... capped at
# 60s. A run that stayed up long enough to be "healthy" resets the backoff so a
# single hiccup after days of uptime doesn't inherit a long delay.
backoff=2
while true; do
  echo "[runner] $(date -u +%FT%TZ) launching agent.js" >> "$LOG"
  start=$(date +%s)   # wall-clock seconds at launch, used to measure run length

  # Launch the agent. `/bin/zsh -lic` = login (-l) + interactive (-i) + command
  # (-c) so the user's profile (and thus the `claude` OAuth token) is loaded —
  # see the long note at the top. `exec node agent.js` replaces the shell with
  # node so we don't keep an extra shell process around. All stdout+stderr is
  # appended to the log (`>> "$LOG" 2>&1`). This call BLOCKS until agent.js exits.
  /bin/zsh -lic "cd '$DIR' && exec node agent.js" >> "$LOG" 2>&1
  code=$?                          # the agent's exit code, for the log line below
  run=$(( $(date +%s) - start ))   # how many seconds the agent stayed up

  # A run that lasted >= 60s is considered healthy; reset backoff to its floor so
  # the next restart is fast. Short-lived runs keep the (growing) backoff.
  [ "$run" -ge 60 ] && backoff=2
  echo "[runner] $(date -u +%FT%TZ) agent.js exited (code $code, ran ${run}s); restarting in ${backoff}s" >> "$LOG"

  sleep "$backoff"                 # wait before relaunching
  backoff=$(( backoff * 2 ))       # exponential growth
  [ "$backoff" -gt 60 ] && backoff=60   # ...clamped to a 60s ceiling
done
