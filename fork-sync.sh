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
#   ./fork-sync.sh                 # full sync + rebuild + build + tests
#   ./fork-sync.sh --no-push       # do everything locally, skip pushing to origin
#   ./fork-sync.sh --no-test       # skip the build + test step at the end
#   ./fork-sync.sh --no-drift      # skip the upstream drift check
#   ./fork-sync.sh --keep-backups N  # retain N recent backup tag sets (default 2; 0 = keep all)
#
set -euo pipefail

# ---- Configuration ---------------------------------------------------------

# The fork's features live in .fork/fork-manifest.json (single source of truth).
# The branch lists below are DERIVED from it so there is exactly one place to
# edit when features change. Topology rules:
#   - independent branches  = manifest features WITHOUT a "stackedOn" key
#   - local-merge branches  = manifest features with "mergeIntoLocal": true
#   - stacked/dependent branches keep their bespoke rebuild logic below
#
# The manifest is read from a stable location: the working-tree copy if present
# (e.g. on feat/fork-tooling or local), otherwise extracted from the canonical
# feat/fork-tooling branch. This keeps the script correct no matter which branch
# is checked out when it starts.
resolve_manifest() {
	if [[ -f .fork/fork-manifest.json ]]; then
		MANIFEST=".fork/fork-manifest.json"
	elif git cat-file -e feat/fork-tooling:.fork/fork-manifest.json 2>/dev/null; then
		MANIFEST="$(mktemp)"
		git show feat/fork-tooling:.fork/fork-manifest.json > "$MANIFEST"
		MANIFEST_IS_TEMP=1
	else
		echo "fork-sync: cannot locate .fork/fork-manifest.json" >&2
		exit 2
	fi
}

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

# Populated after resolve_manifest() runs in the workflow section.
INDEPENDENT_BRANCHES=()
LOCAL_MERGE_BRANCHES=()
MANIFEST_ALL_BRANCHES=()
MANIFEST_IS_TEMP=0

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
# How many recent backup/sync-* tag sets to retain after a successful sync.
# Older sets are pruned so they cannot accumulate (see prune_backup_tags).
# Override with --keep-backups N; N=0 keeps all (disables pruning).
KEEP_BACKUPS=2
# Preserve the original argv before the parse loop consumes it with `shift`.
# The self-update re-exec below needs the flags intact; re-exec'ing with a
# post-loop "$@" (empty) silently dropped --no-push/--no-test/--no-drift.
FORK_SYNC_ARGS=("$@")
while [[ $# -gt 0 ]]; do
	case "$1" in
		--no-push) DO_PUSH=0 ;;
		--no-test) DO_TEST=0 ;;
		--no-drift) DO_DRIFT=0 ;;
		--keep-backups)
			shift
			[[ "${1:-}" =~ ^[0-9]+$ ]] || { echo "--keep-backups needs a non-negative integer" >&2; exit 2; }
			KEEP_BACKUPS="$1" ;;
		--keep-backups=*)
			KEEP_BACKUPS="${1#*=}"
			[[ "$KEEP_BACKUPS" =~ ^[0-9]+$ ]] || { echo "--keep-backups needs a non-negative integer" >&2; exit 2; } ;;
		*) echo "Unknown option: $1" >&2; exit 2 ;;
	esac
	shift
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
		FORK_SYNC_REEXEC=1 FORK_SYNC_ROOT="$REPO_ROOT" FORK_SYNC_TMP="$tmp" exec bash "$tmp" "${FORK_SYNC_ARGS[@]}"
	fi
fi
# Remove the temp copy left by a self-update re-exec once we are running.
if [[ -n "${FORK_SYNC_TMP:-}" ]]; then
	trap 'rm -f "$FORK_SYNC_TMP"' EXIT
fi

require_clean_tree

# Resolve the manifest (working tree or feat/fork-tooling) and derive branch lists.
resolve_manifest
mapfile -t INDEPENDENT_BRANCHES < <(read_manifest_field independent)
mapfile -t LOCAL_MERGE_BRANCHES < <(read_manifest_field local-merge)
mapfile -t MANIFEST_ALL_BRANCHES < <(read_manifest_field all)
if [[ "${MANIFEST_IS_TEMP:-0}" -eq 1 ]]; then
	trap 'rm -f "$MANIFEST" "${FORK_SYNC_TMP:-}"' EXIT
fi
if [[ "${#LOCAL_MERGE_BRANCHES[@]}" -eq 0 ]]; then
	die "Manifest produced no branches; refusing to rebuild an empty local."
fi
say "Ensuring fork git config is installed (merge driver + rerere)"
if [[ -x .fork/setup-fork.sh ]]; then
	./.fork/setup-fork.sh >/dev/null
elif git cat-file -e feat/fork-tooling:.fork/setup-fork.sh 2>/dev/null; then
	# Working tree lacks .fork (e.g. launched from a branch without it): run the
	# canonical setup from feat/fork-tooling via a temp checkout of the .fork dir.
	_setup_tmp="$(mktemp -d)"
	git archive feat/fork-tooling .fork | tar -x -C "$_setup_tmp"
	( cd "$REPO_ROOT" && bash "$_setup_tmp/.fork/setup-fork.sh" >/dev/null ) || \
		warn "setup-fork.sh failed; CHANGELOG auto-merge may not be active."
	rm -rf "$_setup_tmp"
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
	# Resolve the drift checker from the working tree or feat/fork-tooling.
	drift_script=""
	drift_tmp=""
	if [[ -f .fork/fork-drift-check.py ]]; then
		drift_script=".fork/fork-drift-check.py"
	elif git cat-file -e feat/fork-tooling:.fork/fork-drift-check.py 2>/dev/null; then
		drift_tmp="$(mktemp)"
		git show feat/fork-tooling:.fork/fork-drift-check.py > "$drift_tmp"
		drift_script="$drift_tmp"
	fi
	if [[ -n "$drift_script" ]]; then
		if python3 "$drift_script" --manifest "$MANIFEST"; then
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
		[[ -n "$drift_tmp" ]] && rm -f "$drift_tmp"
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

# A dependent branch needs rebuilding when it does not already contain the
# CURRENT tip of each of its bases. needs_rebuild <dependent> <base...> returns
# 0 (true) if any base tip is not an ancestor of the dependent, 1 (false) if the
# dependent already sits on top of every base.
#
# Topology-based on purpose: an ancestry test reads the actual commit graph, so
# it is correct whether this is a clean first run or a resume after a mid-sync
# abort. (The earlier snapshot approach compared each base to a backup tag made
# THIS run; on a resume the base was already rebased by the aborted run, so the
# fresh tag equalled it and the check wrongly reported "unchanged", silently
# skipping the dependent rebuild and stranding it on old upstream.)
needs_rebuild() {
	local dependent="$1"; shift
	local base
	for base in "$@"; do
		if ! git merge-base --is-ancestor "$base" "$dependent" 2>/dev/null; then
			return 0  # base tip not yet contained in dependent: rebuild
		fi
	done
	return 1
}

# Returns 0 if rerere (autoupdate) has fully resolved the in-progress conflict:
# no unmerged index entries remain and no stray conflict markers are left in
# tracked files. Lets the cherry-pick/rebase blocks below auto-continue a
# recurring conflict rerere already knows how to resolve (e.g. the
# footer-width.test.ts import union) instead of aborting, honoring the FORK.md
# promise that resolving a conflict once records it for next time.
rerere_autoresolved() {
	[[ -z "$(git ls-files -u)" ]] || return 1
	if git grep -lE '^(<<<<<<<|>>>>>>>)' -- ':!fork-sync.sh' ':!.fork' >/dev/null 2>&1; then
		return 1
	fi
	return 0
}

# Drive an in-progress rebase to completion while rerere keeps resolving each
# stop. Returns 0 when the rebase finishes, 1 if a stop is left unresolved.
continue_rebase_with_rerere() {
	while [[ -d "$(git rev-parse --git-path rebase-merge)" || -d "$(git rev-parse --git-path rebase-apply)" ]]; do
		rerere_autoresolved || return 1
		git add -A
		GIT_EDITOR=true git rebase --continue >/dev/null 2>&1 || return 1
	done
	return 0
}

rebuild_dependent_branches() {
	# markdown-path-linkify: replay its commits onto the new toolpath tip.
	if needs_rebuild feat/markdown-path-linkify feat/theme-toolpath-color; then
		say "Rebuilding feat/markdown-path-linkify on feat/theme-toolpath-color"
		local old_toolpath
		# Cut point = where this dependent diverges from the (already-rebased) base.
		# Deriving it from the branch graph is resume-safe; the old per-run backup
		# tag pointed at the rebased base after a mid-sync abort and corrupted the
		# replay range. rebase's patch-id dedup drops the base commits that are
		# already in the new base, exactly as `git rebase main` does above.
		old_toolpath="$(git merge-base feat/theme-toolpath-color feat/markdown-path-linkify)"
		git switch feat/markdown-path-linkify -q
		if ! git rebase --onto feat/theme-toolpath-color "$old_toolpath" feat/markdown-path-linkify; then
			# A recurring conflict may have been auto-resolved by rerere; drive the
			# rebase to completion before giving up.
			if ! continue_rebase_with_rerere; then
				git rebase --abort || true
				die "Rebase conflict in feat/markdown-path-linkify. Resolve manually."
			fi
		fi
		push_lease feat/markdown-path-linkify
	else
		say "feat/markdown-path-linkify base unchanged; skipping rebuild"
		push_lease feat/markdown-path-linkify
	fi

	# vscode-terminal-paths: stacks on markdown-path-linkify. Replay its commit
	# onto the (possibly rebuilt) markdown-path-linkify tip. Must run AFTER the
	# markdown rebuild above so it lands on the new base.
	if needs_rebuild fix/vscode-terminal-paths feat/markdown-path-linkify; then
		say "Rebuilding fix/vscode-terminal-paths on feat/markdown-path-linkify"
		local old_mdlink
		# Resume-safe cut point (see markdown-path-linkify above).
		old_mdlink="$(git merge-base feat/markdown-path-linkify fix/vscode-terminal-paths)"
		git switch fix/vscode-terminal-paths -q
		if ! git rebase --onto feat/markdown-path-linkify "$old_mdlink" fix/vscode-terminal-paths; then
			if ! continue_rebase_with_rerere; then
				git rebase --abort || true
				die "Rebase conflict in fix/vscode-terminal-paths. Resolve manually."
			fi
		fi
		push_lease fix/vscode-terminal-paths
	else
		say "fix/vscode-terminal-paths base unchanged; skipping rebuild"
		push_lease fix/vscode-terminal-paths
	fi

	# footer-thinking-level-color: single commit on top of max-thinking.
	if needs_rebuild feat/footer-thinking-level-color feat/max-thinking-level; then
		say "Rebuilding feat/footer-thinking-level-color on feat/max-thinking-level"
		local footer_commit
		footer_commit="$(git log --format=%H -1 "${BACKUP_PREFIX}/feat-footer-thinking-level-color")"
		git switch -C feat/footer-thinking-level-color feat/max-thinking-level -q
		if ! git cherry-pick "$footer_commit"; then
			# Upstream footer changes recur in footer.ts/footer-width.test.ts; let
			# rerere resolve the import/stat union and continue instead of aborting.
			if rerere_autoresolved; then
				git add -A
				git cherry-pick --continue --no-edit || \
					die "Cherry-pick resolution staged but continue failed in feat/footer-thinking-level-color. Resolve manually."
			else
				git cherry-pick --abort || true
				die "Cherry-pick conflict in feat/footer-thinking-level-color. Resolve manually."
			fi
		fi
		push_lease feat/footer-thinking-level-color
	else
		say "feat/footer-thinking-level-color base unchanged; skipping rebuild"
		push_lease feat/footer-thinking-level-color
	fi

	# theme-missing-token-warning: needs both token features, then 1 commit.
	if needs_rebuild feat/theme-missing-token-warning feat/max-thinking-level feat/theme-toolpath-color; then
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

# Auto-resolve the recurring ThemeColor union conflicts in theme.ts (multiple
# fork features add members to the same string-literal unions). Delegates to
# .fork/resolve-theme-union.py, which unions all conflicting members and handles
# nested markers. Returns 0 if no conflict markers remain (resolved, possibly by
# rerere), 1 if anything could not be auto-resolved.
resolve_theme_token_union() {
	local f="packages/coding-agent/src/modes/interactive/theme/theme.ts"
	# If rerere already resolved everything, there are no unmerged files left.
	if [[ -z "$(git ls-files -u)" ]]; then
		if git grep -lE '^(<<<<<<<|>>>>>>>)' -- ':!fork-sync.sh' ':!.fork' >/dev/null 2>&1; then
			return 1
		fi
		return 0
	fi
	# Only theme.ts should be in conflict; bail if anything else is unmerged.
	local unmerged
	unmerged="$(git ls-files -u | awk '{print $4}' | sort -u)"
	[[ "$unmerged" == "$f" ]] || return 1
	if [[ ! -f .fork/resolve-theme-union.py ]]; then
		warn ".fork/resolve-theme-union.py missing; cannot auto-resolve theme.ts."
		return 1
	fi
	python3 .fork/resolve-theme-union.py "$f" || return 1
	git add "$f"
}

rebuild_dependent_branches

# Safety gate: every feature branch must now sit on the new main. A branch that
# does not contain main is stale (e.g. a dependent rebuild that was wrongly
# skipped) and would silently ship old upstream code via the merge into local.
# Fail loudly and name the offenders instead of building a quietly-wrong local.
say "Verifying all feature branches contain the new main"
stale_branches=()
for b in "${MANIFEST_ALL_BRANCHES[@]}"; do
	git rev-parse --verify -q "$b" >/dev/null || continue
	if ! git merge-base --is-ancestor main "$b" 2>/dev/null; then
		stale_branches+=("$b")
	fi
done
if [[ "${#stale_branches[@]}" -gt 0 ]]; then
	for b in "${stale_branches[@]}"; do warn "  stale (not on new main): $b"; done
	die "Refusing to rebuild local: the branches above are not on the new main. Re-run ./fork-sync.sh (resume-safe) or rebase them manually."
fi
echo "  all ${#MANIFEST_ALL_BRANCHES[@]} feature branches contain main"

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
	# Guard against rerere autoupdate committing a bad (marker-laden) resolution.
	if git grep -lE '^(<<<<<<<|>>>>>>>)' -- ':!fork-sync.sh' ':!.fork' >/dev/null 2>&1; then
		warn "Conflict markers detected after merging $b; re-resolving theme union."
		f="packages/coding-agent/src/modes/interactive/theme/theme.ts"
		if [[ -f .fork/resolve-theme-union.py ]] && python3 .fork/resolve-theme-union.py "$f"; then
			git add "$f"
			git commit --no-verify -q --amend --no-edit
		else
			die "Stray conflict markers after merging $b; resolve manually."
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

# Prune old backup tag sets so they cannot pile up across many syncs. Keeps the
# KEEP_BACKUPS most recent backup/sync-<timestamp> sets (including this run's)
# and deletes the rest locally. Timestamps sort lexically, so newest = last.
# Local-only and reversible via reflog; never touches origin.
prune_backup_tags() {
	[[ "$KEEP_BACKUPS" -gt 0 ]] || { echo "  (backup pruning disabled: --keep-backups 0)"; return 0; }
	local sets
	mapfile -t sets < <(git tag -l 'backup/sync-*' | sed 's#/[^/]*$##' | sort -u)
	local total="${#sets[@]}"
	(( total > KEEP_BACKUPS )) || { echo "  ${total} backup set(s); within keep limit (${KEEP_BACKUPS})."; return 0; }
	local drop=$(( total - KEEP_BACKUPS )) prefix
	for prefix in "${sets[@]:0:$drop}"; do
		git tag -d $(git tag -l "${prefix}/*") >/dev/null 2>&1 || true
	done
	echo "  pruned ${drop} old backup set(s); kept ${KEEP_BACKUPS} most recent."
}

say "Pruning old backup tags (keep ${KEEP_BACKUPS})"
prune_backup_tags

say "Done. local is rebuilt on upstream/main + all features."
echo "Backups: tags under ${BACKUP_PREFIX}/  (delete with: git tag -d \$(git tag -l '${BACKUP_PREFIX}/*'))"
echo "Run your build target as usual; pi runs from the local checkout's dist/."
