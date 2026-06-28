#!/usr/bin/env bash
#
# setup-fork.sh — one-time (idempotent) local git configuration for the fork.
#
# Installs the fork's CHANGELOG merge driver and enables rerere so recurring
# conflicts auto-resolve during upstream syncs. Safe to run repeatedly; it only
# sets local repo config (.git/config) and never rewrites history.
#
# The merge driver is wired up entirely through LOCAL git state so nothing fork-
# specific lands in tracked files (the repo's .gitattributes is upstream-owned):
#   - the driver SCRIPT is copied into .git/fork/ so it exists regardless of
#     which branch is checked out (the tracked .fork/ copy only lives on the
#     feat/fork-tooling branch, which is not present during feature rebases)
#   - the driver command lives in .git/config (git requires it there)
#   - the path->driver mapping lives in .git/info/attributes (untracked)
# Every fresh clone must run this once.
#
# Usage:  ./.fork/setup-fork.sh
#
set -euo pipefail

GIT_DIR="$(git rev-parse --absolute-git-dir)"
TOPLEVEL="$(git rev-parse --show-toplevel)"
cd "$TOPLEVEL"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

# Resolve a Python 3 interpreter (python3 on Linux/macOS, python or the py
# launcher on Windows). Confirm the candidate actually reports major version 3.
detect_python() {
	local c
	for c in python3 python py; do
		if command -v "$c" >/dev/null 2>&1 &&
			"$c" -c 'import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)' >/dev/null 2>&1; then
			printf '%s' "$c"
			return 0
		fi
	done
	return 1
}
PYTHON_BIN="$(detect_python || true)"

ATTR_LINE='**/CHANGELOG.md merge=fork-changelog'
ATTR_FILE="${GIT_DIR}/info/attributes"
DRIVER_SRC="${TOPLEVEL}/.fork/changelog-merge.py"
DRIVER_DST="${GIT_DIR}/fork/changelog-merge.py"

say "Installing CHANGELOG merge driver into ${GIT_DIR}/fork (branch-independent)"
mkdir -p "${GIT_DIR}/fork"
if [[ -f "$DRIVER_SRC" ]]; then
	cp "$DRIVER_SRC" "$DRIVER_DST"
elif [[ ! -f "$DRIVER_DST" ]]; then
	# Not on a branch that carries .fork/; recover the script from feat/fork-tooling.
	if git cat-file -e feat/fork-tooling:.fork/changelog-merge.py 2>/dev/null; then
		git show feat/fork-tooling:.fork/changelog-merge.py > "$DRIVER_DST"
	else
		warn "Cannot locate .fork/changelog-merge.py; CHANGELOG auto-merge disabled."
	fi
fi

say "Registering fork CHANGELOG merge driver (local repo config)"
git config merge.fork-changelog.name "fork CHANGELOG union"
git config merge.fork-changelog.driver "${PYTHON_BIN:-python3} '${DRIVER_DST}' %O %A %B %A %P"

say "Mapping CHANGELOG.md to the driver (.git/info/attributes, untracked)"
mkdir -p "${GIT_DIR}/info"
touch "${ATTR_FILE}"
if ! grep -qxF "${ATTR_LINE}" "${ATTR_FILE}"; then
	printf '%s\n' "${ATTR_LINE}" >> "${ATTR_FILE}"
fi

say "Enabling rerere (reuse recorded conflict resolutions)"
git config rerere.enabled true
git config rerere.autoupdate true

# Restore the committed rerere resolutions so recurring genuine conflicts
# (e.g. main.ts theme-warning overlap, theme.ts token unions) auto-resolve even
# on a fresh clone or after the local rr-cache is cleared. We only add missing
# entries; existing local resolutions are left untouched.
RR_DST="${GIT_DIR}/rr-cache"
RR_SRC=""
RR_TMP=""
if [[ -d "${TOPLEVEL}/.fork/rr-cache" ]]; then
	RR_SRC="${TOPLEVEL}/.fork/rr-cache"
elif git cat-file -t feat/fork-tooling:.fork/rr-cache >/dev/null 2>&1; then
	RR_TMP="$(mktemp -d)"
	git archive feat/fork-tooling .fork/rr-cache 2>/dev/null | tar -x -C "$RR_TMP" 2>/dev/null
	RR_SRC="${RR_TMP}/.fork/rr-cache"
fi
if [[ -n "$RR_SRC" && -d "$RR_SRC" ]]; then
	count=0
	mkdir -p "$RR_DST"
	for d in "$RR_SRC"/*/; do
		[[ -d "$d" ]] || continue
		name="$(basename "$d")"
		# Only restore complete (preimage + postimage) resolutions over a missing entry.
		if [[ -e "$d/preimage" && -e "$d/postimage" && ! -e "$RR_DST/$name/postimage" ]]; then
			mkdir -p "$RR_DST/$name"
			cp "$d/preimage" "$d/postimage" "$RR_DST/$name/" && count=$((count + 1))
		fi
	done
	[[ "$count" -gt 0 ]] && say "Restored ${count} rerere resolution(s) into ${RR_DST}"
fi
[[ -n "$RR_TMP" ]] && rm -rf "$RR_TMP"

if [[ -z "$PYTHON_BIN" ]]; then
	printf '\033[1;33m!! No Python 3 found on PATH (tried python3, python, py); the CHANGELOG merge driver needs it.\033[0m\n'
fi

say "Done. Fork git config installed."
echo "  - merge.fork-changelog driver -> ${DRIVER_DST}"
echo "  - ${ATTR_FILE} maps **/CHANGELOG.md -> fork-changelog"
echo "  - rerere enabled (autoupdate on)"
echo "Run ./fork-sync.sh to sync with upstream and rebuild the local branch."
