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
#   - the driver command lives in .git/config (git requires it there)
#   - the path->driver mapping lives in .git/info/attributes (untracked)
# Every fresh clone must run this once.
#
# Usage:  ./.fork/setup-fork.sh
#
set -euo pipefail

GIT_DIR="$(git rev-parse --git-dir)"
cd "$(git rev-parse --show-toplevel)"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }

ATTR_LINE='**/CHANGELOG.md merge=fork-changelog'
ATTR_FILE="${GIT_DIR}/info/attributes"

say "Registering fork CHANGELOG merge driver (local repo config)"
git config merge.fork-changelog.name "fork CHANGELOG union"
git config merge.fork-changelog.driver 'python3 .fork/changelog-merge.py %O %A %B %A %P'

say "Mapping CHANGELOG.md to the driver (.git/info/attributes, untracked)"
mkdir -p "${GIT_DIR}/info"
touch "${ATTR_FILE}"
if ! grep -qxF "${ATTR_LINE}" "${ATTR_FILE}"; then
	printf '%s\n' "${ATTR_LINE}" >> "${ATTR_FILE}"
fi

say "Enabling rerere (reuse recorded conflict resolutions)"
git config rerere.enabled true
git config rerere.autoupdate true

if ! command -v python3 >/dev/null 2>&1; then
	printf '\033[1;33m!! python3 not found on PATH; the CHANGELOG merge driver needs it.\033[0m\n'
fi

say "Done. Fork git config installed."
echo "  - merge.fork-changelog driver -> .fork/changelog-merge.py"
echo "  - ${ATTR_FILE} maps **/CHANGELOG.md -> fork-changelog"
echo "  - rerere enabled (autoupdate on)"
echo "Run ./fork-sync.sh to sync with upstream and rebuild the local branch."
