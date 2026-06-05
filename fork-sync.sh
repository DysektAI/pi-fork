#!/usr/bin/env bash
#
# fork-sync.sh — sync this fork with upstream and rebuild the integration branch.
#
# Fork-specific helper (not from upstream). It performs the maintenance workflow:
#   1. Fetch upstream + origin.
#   2. Fast-forward `main` to `upstream/main` and push it.
#   3. Rebase each independent feature branch onto the new `main`.
#   4. Rebuild the stacked/dependent branches onto their dependencies.
#   5. Rebuild the `local` integration branch (main + every feature merged).
#   6. Build and run bounded sanity tests.
#
# Branch model (see also AGENTS-fork notes):
#   main   — pristine mirror of upstream/main (never holds fork commits)
#   feat/* — one feature per branch; some are stacked (see DEPENDENCIES below)
#   local  — main + all feat/* merged; this is the branch you run/build
#
# Safety:
#   - Creates backup tags (backup/sync-<timestamp>/*) before rewriting history.
#   - Uses --force-with-lease for all force pushes.
#   - Aborts on any rebase/merge conflict and tells you which branch to fix.
#   - Never runs the unbounded test suite (caps workers via VITEST_MAX_FORKS).
#
# Usage:
#   ./fork-sync.sh            # full sync + rebuild + build + tests
#   ./fork-sync.sh --no-push  # do everything locally, skip pushing to origin
#   ./fork-sync.sh --no-test  # skip the build + test step at the end
#
set -euo pipefail

# ---- Configuration ---------------------------------------------------------

# Independent feature branches: rebased directly onto main.
INDEPENDENT_BRANCHES=(
	"feat/fork-tooling"
	"feat/theme-toolpath-color"
	"feat/max-thinking-level"
	"feat/markdown-codeblock-border-style"
	"feat/test-bounded-pool"
)

# Stacked/dependent branches, expressed as "branch:base:commit_or_range".
# Rebuilt by recreating <branch> on <base> and replaying the listed commits.
# Keep these ranges in sync when you add commits to a dependent branch.
#
#   markdown-path-linkify   stacks on theme-toolpath-color (3 linkify commits)
#   footer-thinking-color   stacks on max-thinking          (1 commit)
#   theme-missing-token     needs max-thinking + toolpath   (merge + 1 commit)
#
# These are handled explicitly in rebuild_dependent_branches() because each has
# a slightly different shape; edit that function if the topology changes.

# Branches merged into `local` (leaf branches carry their own dependencies).
LOCAL_MERGE_BRANCHES=(
	"feat/fork-tooling"
	"feat/markdown-path-linkify"
	"feat/theme-missing-token-warning"
	"feat/footer-thinking-level-color"
	"feat/markdown-codeblock-border-style"
	"feat/test-bounded-pool"
)

# Cap test workers so the runner cannot storm the host (see feat/test-bounded-pool).
export VITEST_MAX_FORKS="${VITEST_MAX_FORKS:-4}"

DO_PUSH=1
DO_TEST=1
for arg in "$@"; do
	case "$arg" in
		--no-push) DO_PUSH=0 ;;
		--no-test) DO_TEST=0 ;;
		*) echo "Unknown option: $arg" >&2; exit 2 ;;
	esac
done

# ---- Helpers ---------------------------------------------------------------

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

require_clean_tree() {
	if [[ -n "$(git status --porcelain)" ]]; then
		die "Working tree is not clean. Commit or stash changes before syncing."
	fi
}

push_lease() {
	local branch="$1"
	if [[ "$DO_PUSH" -eq 1 ]]; then
		git push --force-with-lease origin "$branch"
	else
		echo "  (skipped push of $branch)"
	fi
}

# ---- Workflow --------------------------------------------------------------

cd "$(dirname "$0")"
require_clean_tree

say "Ensuring fork git config is installed (merge driver + rerere)"
if [[ -x .fork/setup-fork.sh ]]; then
	./.fork/setup-fork.sh >/dev/null
else
	warn ".fork/setup-fork.sh not found; CHANGELOG auto-merge may not be active."
fi

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_PREFIX="backup/sync-${TS}"

say "Fetching upstream and origin"
git fetch upstream --prune
git fetch origin --prune

ALL_BRANCHES=("main" "local" "${INDEPENDENT_BRANCHES[@]}"
	"feat/markdown-path-linkify" "feat/footer-thinking-level-color"
	"feat/theme-missing-token-warning")
say "Creating backup tags under ${BACKUP_PREFIX}/"
for b in "${ALL_BRANCHES[@]}"; do
	if git rev-parse --verify "$b" >/dev/null 2>&1; then
		git tag "${BACKUP_PREFIX}/$(echo "$b" | tr '/' '-')" "$b"
		echo "  tagged $b"
	fi
done

say "Fast-forwarding main to upstream/main"
git switch main -q
git merge --ff-only upstream/main
push_lease main

say "Rebasing independent feature branches onto main"
for b in "${INDEPENDENT_BRANCHES[@]}"; do
	echo "--- $b ---"
	git switch "$b" -q
	if ! git rebase main; then
		git rebase --abort || true
		die "Rebase conflict in $b. Resolve manually:  git switch $b && git rebase main"
	fi
	push_lease "$b"
done

rebuild_dependent_branches() {
	# markdown-path-linkify: replay its 3 commits onto the new toolpath tip.
	say "Rebuilding feat/markdown-path-linkify on feat/theme-toolpath-color"
	local old_toolpath
	old_toolpath="$(git rev-parse "${BACKUP_PREFIX}/feat-theme-toolpath-color")"
	git switch feat/markdown-path-linkify -q
	if ! git rebase --onto feat/theme-toolpath-color "$old_toolpath" feat/markdown-path-linkify; then
		git rebase --abort || true
		die "Rebase conflict in feat/markdown-path-linkify. Resolve manually."
	fi
	push_lease feat/markdown-path-linkify

	# footer-thinking-level-color: single commit on top of max-thinking.
	say "Rebuilding feat/footer-thinking-level-color on feat/max-thinking-level"
	local footer_commit
	footer_commit="$(git log --format=%H -1 "${BACKUP_PREFIX}/feat-footer-thinking-level-color")"
	git switch -C feat/footer-thinking-level-color feat/max-thinking-level -q
	if ! git cherry-pick "$footer_commit"; then
		git cherry-pick --abort || true
		die "Cherry-pick conflict in feat/footer-thinking-level-color. Resolve manually."
	fi
	push_lease feat/footer-thinking-level-color

	# theme-missing-token-warning: needs both token features, then 1 commit.
	say "Rebuilding feat/theme-missing-token-warning on max-thinking + toolpath"
	local warn_commit
	warn_commit="$(git log --format=%H -1 "${BACKUP_PREFIX}/feat-theme-missing-token-warning")"
	git switch -C feat/theme-missing-token-warning feat/max-thinking-level -q
	if ! git merge --no-ff feat/theme-toolpath-color \
		-m "merge: combine max-thinking and toolpath as the optional-token base"; then
		warn "theme.ts token-union conflict expected; resolving automatically."
		resolve_theme_token_union || die "Could not auto-resolve theme.ts; resolve manually."
		git commit --no-verify -q --no-edit
	fi
	if ! git cherry-pick "$warn_commit"; then
		git cherry-pick --abort || true
		die "Cherry-pick conflict in feat/theme-missing-token-warning. Resolve manually."
	fi
	push_lease feat/theme-missing-token-warning
}

# Auto-resolve the recurring ThemeColor union conflict (toolPath + thinkingMax).
resolve_theme_token_union() {
	local f="packages/coding-agent/src/modes/interactive/theme/theme.ts"
	git ls-files -u | awk '{print $4}' | sort -u | grep -qx "$f" || return 1
	python3 - "$f" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
conflict = '''\t| "thinkingXhigh"
<<<<<<< HEAD
\t| "thinkingMax"
\t| "bashMode";
=======
\t| "bashMode"
\t| "toolPath";
>>>>>>> feat/theme-toolpath-color'''
resolved = '''\t| "thinkingXhigh"
\t| "thinkingMax"
\t| "bashMode"
\t| "toolPath";'''
if conflict not in s:
    sys.exit(1)
open(p, "w").write(s.replace(conflict, resolved))
PY
	git add "$f"
}

rebuild_dependent_branches

say "Rebuilding local integration branch"
git switch -C local main -q
for b in "${LOCAL_MERGE_BRANCHES[@]}"; do
	echo "--- merging $b ---"
	if ! git merge --no-ff "$b" -m "merge: integrate $b into local"; then
		if resolve_theme_token_union; then
			git commit --no-verify -q --no-edit
		else
			die "Merge conflict integrating $b into local. Resolve manually."
		fi
	fi
done

if [[ "$DO_TEST" -eq 1 ]]; then
	say "Building (sequential, single-process per package)"
	npm run build

	say "Committing regenerated model data if the build changed it"
	if [[ -n "$(git status --porcelain)" ]]; then
		if git status --porcelain | grep -qvE 'generated'; then
			warn "Non-generated files changed during build; leaving tree dirty for review."
			git status --short
		else
			git add packages/ai/src/*.generated.ts
			git commit --no-verify -q -m "chore(ai): regenerate model data on local integration branch"
		fi
	fi

	say "Running bounded sanity tests (VITEST_MAX_FORKS=${VITEST_MAX_FORKS})"
	( cd packages/coding-agent && npx vitest --run \
		--pool=forks --poolOptions.forks.singleFork=true --poolOptions.forks.maxForks=1 \
		test/theme-missing-tokens.test.ts test/footer-width.test.ts \
		test/theme-toolpath.test.ts test/markdown-path-linkify.test.ts )
fi

push_lease local

say "Done. local is rebuilt on upstream/main + all features."
echo "Backups: tags under ${BACKUP_PREFIX}/  (delete with: git tag -d \$(git tag -l '${BACKUP_PREFIX}/*'))"
echo "Run your build target as usual; pi runs from the local checkout's dist/."
