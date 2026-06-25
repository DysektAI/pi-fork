#!/usr/bin/env bash
#
# fork-auto-sync.sh — unattended daily wrapper around fork-sync.sh.
#
# Intended to be invoked by a scheduler (systemd user timer). It:
#   1. Runs the canonical fork-sync.sh (full sync + rebuild + build + tests),
#      branch-agnostically (resolved from feat/fork-tooling), so dist/ is
#      rebuilt in place and the ~/.local/bin/pi shim launches current code.
#   1b. Updates installed pi packages (`pi update --extensions`) with the
#      freshly built fork CLI, so git/npm extensions track their remotes
#      without a manual `pi update --extensions`. Best-effort: a failed
#      extension fetch is logged but never fails the unit or masks a sync
#      conflict.
#   2. Logs everything (timestamped) under $XDG_STATE_HOME/pi-fork/.
#   3. On a conflict/error (fork-sync.sh exits nonzero), writes a CONFLICT
#      marker file and exits nonzero so the systemd unit is marked failed.
#      Both the marker and `systemctl --user status fork-sync` surface it.
#   4. On success, clears any stale marker.
#
# It NEVER forces past a conflict: fork-sync.sh aborts the offending rebase and
# this wrapper just reports it. You resolve once by hand; rerere replays it next
# time (see FORK.md).
#
# Manual run:  bash .fork/fork-auto-sync.sh
set -uo pipefail

REPO_ROOT="${FORK_SYNC_ROOT:-/home/lab/pi-fork}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pi-fork"
LOG="$STATE_DIR/auto-sync.log"
MARKER="$STATE_DIR/CONFLICT"
# Keep the daily run from colliding with itself if a previous one is still going.
LOCK="$STATE_DIR/auto-sync.lock"

mkdir -p "$STATE_DIR"

# Single-instance guard (flock if available; harmless no-op otherwise).
if command -v flock >/dev/null 2>&1; then
	exec 9>"$LOCK"
	if ! flock -n 9; then
		echo "$(date -Is) another fork-auto-sync is running; skipping." >> "$LOG"
		exit 0
	fi
fi

ts() { date -Is; }

{
	echo "==================================================================="
	echo "$(ts) fork-auto-sync starting (repo: $REPO_ROOT)"
} >> "$LOG"

cd "$REPO_ROOT" || { echo "$(ts) cannot cd to $REPO_ROOT" >> "$LOG"; exit 1; }

# Resolve the canonical fork-sync.sh from feat/fork-tooling so this works no
# matter which branch is checked out (same pattern fork-sync.sh uses itself).
sync_tmp="$(mktemp)"
if ! git show feat/fork-tooling:fork-sync.sh > "$sync_tmp" 2>>"$LOG"; then
	echo "$(ts) ERROR: could not read fork-sync.sh from feat/fork-tooling" >> "$LOG"
	rm -f "$sync_tmp"
	exit 1
fi
chmod +x "$sync_tmp"

# Run the full sync, tee output into the log. PATH must include node/npm; the
# systemd unit sets that. Capture fork-sync.sh's exit code, not tee's.
FORK_SYNC_ROOT="$REPO_ROOT" bash "$sync_tmp" 2>&1 | tee -a "$LOG"
rc="${PIPESTATUS[0]}"
rm -f "$sync_tmp"

# Update installed pi packages (git/npm extensions) with the freshly built fork
# CLI. Extensions live under ~/.pi/agent and are independent of the fork rebase,
# so run this regardless of the sync result and keep it non-fatal: a flaky
# extension fetch must not mask a real sync conflict or trip the CONFLICT marker.
# PI_SKIP_VERSION_CHECK matches the ~/.local/bin/pi launcher (a self-maintained
# fork must never self-update into the npm package).
CLI_JS="$REPO_ROOT/packages/coding-agent/dist/cli.js"
if [[ -f "$CLI_JS" ]]; then
	echo "$(ts) updating pi extensions" >> "$LOG"
	if PI_SKIP_VERSION_CHECK=1 node "$CLI_JS" update --extensions >> "$LOG" 2>&1; then
		echo "$(ts) pi extensions up to date" >> "$LOG"
	else
		echo "$(ts) WARNING: pi extension update failed (non-fatal); see log above" >> "$LOG"
	fi
else
	echo "$(ts) WARNING: $CLI_JS missing; skipped extension update" >> "$LOG"
fi

if [[ "$rc" -eq 0 ]]; then
	echo "$(ts) fork-auto-sync OK" >> "$LOG"
	rm -f "$MARKER"
	exit 0
fi

# Non-zero: fork-sync.sh aborted (almost always a genuine rebase/merge conflict
# it refused to force past). Record a marker with the tail of the log so it is
# obvious what needs a manual resolve.
{
	echo "fork-auto-sync FAILED at $(ts) (exit $rc)"
	echo "A branch hit a conflict fork-sync.sh would not auto-resolve."
	echo "Resolve it once by hand (rerere will remember):"
	echo "  cd $REPO_ROOT"
	echo "  # see which branch in the log below, then:  git switch <branch> && git rebase main"
	echo "Full log: $LOG"
	echo "--- last 25 log lines ---"
	tail -n 25 "$LOG"
} > "$MARKER"

echo "$(ts) fork-auto-sync FAILED (exit $rc); wrote $MARKER" >> "$LOG"
exit "$rc"
