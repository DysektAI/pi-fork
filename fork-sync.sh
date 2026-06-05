#!/usr/bin/env bash
#
# fork-sync.sh — sync this fork with upstream and rebuild the integration branch.
#
# Fork-specific helper (not from upstream). It performs the maintenance workflow:
#   1. Fetch upstream + origin.
#   2. Check feature drift against upstream (flag patches upstream absorbed).
#   3. Fast-forward `main` to `upstream/main` and push it.
#   4. Rebase each independent feature branch onto the new `main`.
#   5. Rebuild the stacked/dependent branches onto their dependencies.
#   6. Rebuild the `local` integration branch (main + every feature merged).
#   7. Build and run bounded sanity tests.
#
# Features are declared in .fork/fork-manifest.json (single source of truth);
# the branch lists in this script are derived from it.
#
# Branch model (see also FORK.md):
#   main   — pristine mirror of upstream/main (never holds fork commits)
#   feat/* — one feature per branch; some are stacked (see manifest stackedOn)
#   local  — main + all feat/* merged; this is the branch you run/build
#
# Safety:
#   - Creates backup tags (backup/sync-<timestamp>/*) before rewriting history.
#   - Uses --force-with-lease for all force pushes.
#   - Aborts on any rebase/merge conflict and tells you which branch to fix.
#   - Never runs the unbounded test suite (caps workers via VITEST_MAX_FORKS).
#
# Usage:
#   ./fork-sync.sh             # full sync + rebuild + build + tests
#   ./fork-sync.sh --no-push   # do everything locally, skip pushing to origin
#   ./fork-sync.sh --no-test   # skip the build + test step at the end
#   ./fork-sync.sh --no-drift  # skip the upstream drift check
#
set -euo pipefail

# ---- Configuration ---------------------------------------------------------

# The fork's features live in .fork/fork-manifest.json (single source of truth).
# The branch lists below are DERIVED from it so there is exactly one place to
# edit when features change. Topology rules:
#   - independent branches  = manifest features WITHOUT a "stackedOn" key
#   - local-merge branches  = manifest features with "mergeIntoLocal": true
#   - stacked/dependent branches keep their bespoke rebuild logic below
MANIFEST=".fork/fork-manifest.json"

read_manifest_field() {
	# $1 = a jq-like selector implemented in python. Prints one branch per line.
	python3 - "$MANIFEST" "$1" <<'PY'
import json, sys
manifest, mode = sys.argv[1], sys.argv[2]
data = json.load(open(manifest))
for f in data["features"]:
    if mode == "independent" and "stackedOn" not in f:
        print(f["branch"])
    elif mode == "local-merge" and f.get("mergeIntoLocal"):
        print(f["branch"])
    elif mode == "all":
        print(f["branch"])
PY
}

mapfile -t INDEPENDENT_BRANCHES < <(read_manifest_field independent)
mapfile -t LOCAL_MERGE_BRANCHES < <(read_manifest_field local-merge)
mapfile -t MANIFEST_ALL_BRANCHES < <(read_manifest_field all)

# Stacked/dependent branches keep bespoke rebuild logic in
# rebuild_dependent_branches() because each has a different shape (cherry-pick
# vs merge). The manifest records their topology via "stackedOn":
#   markdown-path-linkify   stacks on theme-toolpath-color
#   footer-thinking-color   stacks on max-thinking
#   theme-missing-token     needs max-thinking + toolpath

# Cap test workers so the runner cannot storm the host (see feat/test-bounded-pool).
export VITEST_MAX_FORKS="${VITEST_MAX_FORKS:-4}"

DO_PUSH=1
DO_TEST=1
DO_DRIFT=1
for arg in "$@"; do
	case "$arg" in
		--no-push) DO_PUSH=0 ;;
		--no-test) DO_TEST=0 ;;
		--no-drift) DO_DRIFT=0 ;;
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

# Anchor to the repo root. After a self-update re-exec the script runs from a
# temp path, so prefer FORK_SYNC_ROOT when set; otherwise derive it from $0.
if [[ -n "${FORK_SYNC_ROOT:-}" ]]; then
	REPO_ROOT="$FORK_SYNC_ROOT"
else
	REPO_ROOT="$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)"
fi
cd "$REPO_ROOT"

# Self-update guard: the canonical fork-sync.sh + .fork tooling live on
# feat/fork-tooling. Whichever branch you launch from, re-exec the canonical
# version so a fix on feat/fork-tooling takes effect immediately (avoids the
# bootstrap problem where `local` still carries an older script). The re-exec
# stays anchored to the repo via FORK_SYNC_ROOT and cleans its temp copy.
if [[ "${FORK_SYNC_REEXEC:-0}" -ne 1 ]] && git rev-parse --verify -q feat/fork-tooling >/dev/null; then
	canonical="$(git show feat/fork-tooling:fork-sync.sh 2>/dev/null || true)"
	if [[ -n "$canonical" && "$canonical" != "$(cat "$REPO_ROOT/fork-sync.sh" 2>/dev/null)" ]]; then
		warn "Running canonical fork-sync.sh from feat/fork-tooling (self-update)."
		tmp="$(mktemp)"
		printf '%s' "$canonical" > "$tmp"
		chmod +x "$tmp"
		FORK_SYNC_REEXEC=1 FORK_SYNC_ROOT="$REPO_ROOT" FORK_SYNC_TMP="$tmp" exec bash "$tmp" "$@"
	fi
fi
# Remove the temp copy left by a self-update re-exec once we are running.
if [[ -n "${FORK_SYNC_TMP:-}" ]]; then
	trap 'rm -f "$FORK_SYNC_TMP"' EXIT
fi

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

if [[ "$DO_DRIFT" -eq 1 ]]; then
	say "Checking feature drift against upstream/main"
	if [[ -f .fork/fork-drift-check.py ]]; then
		if python3 .fork/fork-drift-check.py; then
			: # all features ACTIVE
		else
			rc=$?
			if [[ "$rc" -eq 3 ]]; then
				warn "Some features look REDUNDANT upstream (see above). They are still"
				warn "being applied; review .fork/fork-manifest.json and drop any that are"
				warn "no longer needed. Continuing sync in 5s (Ctrl-C to stop)..."
				sleep 5
			else
				warn "Drift check reported an error (exit $rc); continuing."
			fi
		fi
	else
		warn ".fork/fork-drift-check.py not found; skipping drift check."
	fi
fi

ALL_BRANCHES=("main" "local" "${MANIFEST_ALL_BRANCHES[@]}")
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

# A dependent branch only needs rebuilding when one of its bases actually moved
# since the pre-sync snapshot. base_moved <branch...> returns 0 (true) if any
# listed base differs from its backup tag, 1 (false) if all bases are unchanged.
base_moved() {
	local base tag
	for base in "$@"; do
		tag="${BACKUP_PREFIX}/$(echo "$base" | tr '/' '-')"
		if ! git rev-parse --verify -q "$tag" >/dev/null; then
			return 0  # no snapshot: rebuild to be safe
		fi
		if [[ "$(git rev-parse "$base")" != "$(git rev-parse "$tag")" ]]; then
			return 0
		fi
	done
	return 1
}

rebuild_dependent_branches() {
	# markdown-path-linkify: replay its commits onto the new toolpath tip.
	if base_moved feat/theme-toolpath-color; then
		say "Rebuilding feat/markdown-path-linkify on feat/theme-toolpath-color"
		local old_toolpath
		old_toolpath="$(git rev-parse "${BACKUP_PREFIX}/feat-theme-toolpath-color")"
		git switch feat/markdown-path-linkify -q
		if ! git rebase --onto feat/theme-toolpath-color "$old_toolpath" feat/markdown-path-linkify; then
			git rebase --abort || true
			die "Rebase conflict in feat/markdown-path-linkify. Resolve manually."
		fi
		push_lease feat/markdown-path-linkify
	else
		say "feat/markdown-path-linkify base unchanged; skipping rebuild"
		push_lease feat/markdown-path-linkify
	fi

	# footer-thinking-level-color: single commit on top of max-thinking.
	if base_moved feat/max-thinking-level; then
		say "Rebuilding feat/footer-thinking-level-color on feat/max-thinking-level"
		local footer_commit
		footer_commit="$(git log --format=%H -1 "${BACKUP_PREFIX}/feat-footer-thinking-level-color")"
		git switch -C feat/footer-thinking-level-color feat/max-thinking-level -q
		if ! git cherry-pick "$footer_commit"; then
			git cherry-pick --abort || true
			die "Cherry-pick conflict in feat/footer-thinking-level-color. Resolve manually."
		fi
		push_lease feat/footer-thinking-level-color
	else
		say "feat/footer-thinking-level-color base unchanged; skipping rebuild"
		push_lease feat/footer-thinking-level-color
	fi

	# theme-missing-token-warning: needs both token features, then 1 commit.
	if base_moved feat/max-thinking-level feat/theme-toolpath-color; then
		say "Rebuilding feat/theme-missing-token-warning on max-thinking + toolpath"
		local warn_commit
		warn_commit="$(git log --format=%H -1 "${BACKUP_PREFIX}/feat-theme-missing-token-warning")"
		git switch -C feat/theme-missing-token-warning feat/max-thinking-level -q
		if ! git merge --no-ff feat/theme-toolpath-color \
			-m "merge: combine max-thinking and toolpath as the optional-token base"; then
			warn "theme.ts token-union conflict expected; resolving automatically."
			resolve_theme_token_union || die "Could not auto-resolve theme.ts; resolve manually."
			# Complete the merge commit (rerere/our resolver has staged the result).
			git commit --no-verify -q --no-edit || \
				die "Merge resolution staged but commit failed; resolve manually."
		fi
		if ! git cherry-pick "$warn_commit"; then
			# The warn commit can re-touch theme.ts; let rerere/our resolver handle it.
			if resolve_theme_token_union; then
				git cherry-pick --continue --no-edit || \
					die "Cherry-pick resolution staged but continue failed; resolve manually."
			else
				git cherry-pick --abort || true
				die "Cherry-pick conflict in feat/theme-missing-token-warning. Resolve manually."
			fi
		fi
		push_lease feat/theme-missing-token-warning
	else
		say "feat/theme-missing-token-warning base unchanged; skipping rebuild"
		push_lease feat/theme-missing-token-warning
	fi
}

# Auto-resolve the recurring ThemeColor union conflict (toolPath + thinkingMax).
# Returns 0 if the conflict is resolved (either by us or already by rerere),
# 1 if it could not be resolved automatically.
resolve_theme_token_union() {
	local f="packages/coding-agent/src/modes/interactive/theme/theme.ts"
	# If rerere already resolved everything, there are no unmerged files left.
	if [[ -z "$(git ls-files -u)" ]]; then
		# Make sure no conflict markers slipped through anywhere (skip this script,
		# which legitimately contains marker-like strings in its heredoc).
		if git grep -lE '^(<<<<<<<|>>>>>>>)' -- ':!fork-sync.sh' >/dev/null 2>&1; then
			return 1
		fi
		return 0
	fi
	# Only theme.ts should be in conflict; bail if anything else is unmerged.
	local unmerged
	unmerged="$(git ls-files -u | awk '{print $4}' | sort -u)"
	[[ "$unmerged" == "$f" ]] || return 1
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
			git commit --no-verify -q --no-edit || \
				die "Merge resolution staged but commit failed integrating $b."
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
	( cd packages/coding-agent && npx vitest --run --maxWorkers=1 --pool=forks \
		test/theme-missing-tokens.test.ts test/footer-width.test.ts \
		test/theme-toolpath.test.ts test/markdown-path-linkify.test.ts )
fi

push_lease local

say "Done. local is rebuilt on upstream/main + all features."
echo "Backups: tags under ${BACKUP_PREFIX}/  (delete with: git tag -d \$(git tag -l '${BACKUP_PREFIX}/*'))"
echo "Run your build target as usual; pi runs from the local checkout's dist/."
