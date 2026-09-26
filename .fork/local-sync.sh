#!/usr/bin/env bash
#
# local-sync.sh — keep the local pi-fork worktree + dist current with origin/local.
#
# Canonical copy, tracked in the fork at .fork/local-sync.sh. Install on a machine
# by symlinking the units from .fork/systemd/ (see FORK.md, "Automation") so the
# job runs this tracked copy; adapt PI_FORK_ROOT and PATH in the service unit when
# the checkout or the Node installation lives elsewhere.
#
# The GitHub Actions `fork-sync` workflow already keeps origin/local on GitHub
# up to date (sync + push). This script fills the one gap that workflow cannot:
# fast-forwarding the on-disk worktree at /home/lab/pi-fork and rebuilding the
# locally-built dist/ that the ~/.local/bin/pi launcher executes.
#
# It deliberately does NOT push, run drift checks, or run tests — those are the
# GitHub Action's job. It never rewrites history (ff-only) and never forces.
#
# Invoked by: systemd user unit pi-fork-local-sync.service
# Manual run: bash .fork/local-sync.sh
set -uo pipefail

REPO_ROOT="${PI_FORK_ROOT:-/home/lab/pi-fork}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pi-fork"
LOG="$STATE_DIR/local-sync.log"
LOCK="$STATE_DIR/local-sync.lock"

mkdir -p "$STATE_DIR"

# Single-instance guard so a delayed run can't overlap the next one.
if command -v flock >/dev/null 2>&1; then
	exec 9>"$LOCK"
	if ! flock -n 9; then
		echo "$(date -Is) another local-sync is running; skipping." >>"$LOG"
		exit 0
	fi
fi

ts() { date -Is; }

log() { echo "$(ts) $*" >>"$LOG"; }

{
	echo "==================================================================="
	log "local-sync starting (repo: $REPO_ROOT)"
} >>"$LOG"

cd "$REPO_ROOT" || { log "ERROR: cannot cd to $REPO_ROOT"; exit 1; }

# 1. Fetch origin (and upstream, harmless, keeps refs honest for diagnostics).
if ! git fetch --all --prune >>"$LOG" 2>&1; then
	log "ERROR: git fetch failed"
	exit 1
fi

# 2. Abort if the working tree is dirty — never stomp on uncommitted work.
if ! git diff --quiet --ignore-submodules >>"$LOG" 2>&1 || \
   ! git diff --quiet --cached --ignore-submodules >>"$LOG" 2>&1; then
	log "ABORT: working tree has uncommitted changes; refusing to update. Resolve by hand."
	exit 1
fi

# 3. Abort if local has commits not on origin/local — ff-only, never rewrite.
AHEAD=$(git rev-list --count origin/local..HEAD 2>/dev/null || echo "unknown")
if [[ "$AHEAD" != "0" ]]; then
	log "ABORT: local is $AHEAD commits ahead of origin/local (would require non-ff). Skipping; resolve by hand."
	exit 1
fi

# 4. Fast-forward local to origin/local.
BEHIND=$(git rev-list --count HEAD..origin/local 2>/dev/null || echo "unknown")
if [[ "$BEHIND" == "0" ]]; then
	log "already up to date with origin/local"
else
	log "fast-forwarding local $BEHIND commits to origin/local"
	if ! git merge --ff-only origin/local >>"$LOG" 2>&1; then
		log "ERROR: ff-only merge failed (should not happen after the checks above); aborting"
		exit 1
	fi
fi

# 5. Hydrate deps if the lockfile changed (ignore-scripts per fork AGENTS.md).
if ! npm install --ignore-scripts --no-audit --no-fund >>"$LOG" 2>&1; then
	log "ERROR: npm install failed"
	exit 1
fi

# 6. Rebuild dist/ so the launcher runs current code.
if ! npm run build >>"$LOG" 2>&1; then
	log "ERROR: npm run build failed"
	exit 1
fi

log "local-sync OK"
exit 0
