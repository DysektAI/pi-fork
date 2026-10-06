#!/usr/bin/env bash
# Sync the fork by merging upstream into the single long-lived local branch.
set -euo pipefail

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

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

for PYTHON_BIN in python3 python py; do
	command -v "$PYTHON_BIN" >/dev/null 2>&1 && "$PYTHON_BIN" -c 'import sys; raise SystemExit(sys.version_info[0] != 3)' >/dev/null 2>&1 && break
done
"$PYTHON_BIN" -c 'import sys; raise SystemExit(sys.version_info[0] != 3)' >/dev/null 2>&1 || die "Python 3 is required."

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
[[ -z "$(git status --porcelain)" ]] || die "Working tree is not clean. Commit or stash changes first."
[[ "$(git branch --show-current)" == "local" ]] || die "Run fork-sync.sh from the local branch."
git config user.name >/dev/null 2>&1 || git config user.name "fork-sync"
git config user.email >/dev/null 2>&1 || git config user.email "fork-sync@users.noreply.github.com"
"$PYTHON_BIN" .fork/retire-legacy-git-config.py

say "Fetching upstream and origin"
git fetch upstream --prune --tags
git fetch origin --prune

# main is only a local mirror pointer; no checkout or rewritten feature branches.
git branch -f main upstream/main >/dev/null

if [[ "$DO_DRIFT" -eq 1 && -f .fork/fork-drift-check.py ]]; then
	say "Checking which fork patches upstream may have absorbed"
	"$PYTHON_BIN" .fork/fork-drift-check.py || warn "Review REDUNDANT/CHECK entries after this sync."
fi

already_current=0
if git merge-base --is-ancestor main local; then
	already_current=1
	say "Already current with upstream/main; validating the checkout"
fi

backup="backup/sync-$(date +%Y%m%d-%H%M%S)/local"
report_failure() {
	local status="$?"
	if [[ "$status" -ne 0 ]]; then
		warn "Sync stopped. Worktree, index, and any in-progress merge were left for inspection; no automatic rollback or cleanup was performed."
	fi
}
unexpected_changes() {
	if [[ "$already_current" -eq 1 ]]; then
		git status --porcelain
	else
		git diff --name-only
		# Compare against the completed merge index, not HEAD, so upstream changes
		# are expected but concurrent staging is never folded into the sync commit.
		git diff --cached --name-only "$validation_tree" -- . \
			':(exclude)packages/ai/src/*.generated.ts' \
			':(exclude)packages/ai/src/providers/*.models.ts'
		git ls-files --others --exclude-standard
	fi
}

trap report_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$already_current" -eq 0 ]]; then
	git tag "$backup" local

	say "Merging upstream/main into local"
	if ! git merge --no-ff --no-commit main; then
		# Generated catalogs have no hand-written resolution: take upstream, then the
		# build below regenerates them from the merged sources.
		mapfile -t conflicted < <(git diff --name-only --diff-filter=U)
		for file in "${conflicted[@]}"; do
			case "$file" in
				packages/ai/src/*.generated.ts|packages/ai/src/providers/*.models.ts)
					git checkout --theirs -- "$file"
					git add "$file"
					;;
			esac
		done

		remaining="$(git diff --name-only --diff-filter=U)"
		if [[ -n "$remaining" ]]; then
			printf '%s\n' "$remaining" >&2
			die "Upstream overlaps fork code. Resolve the listed files in the current merge on local, test, and commit. Backup: $backup"
		fi
	fi
fi

validation_tree="$(git write-tree)"
allow_lockfile_change=0
if [[ "$DO_TEST" -eq 1 ]]; then
	if [[ "${FORK_SYNC_NPM_CI:-0}" == "1" ]]; then
		say "Installing dependencies"
		npm ci --ignore-scripts --no-audit --no-fund
	fi

	say "Building"
	npm run build

	# Stage generated model catalogs rewritten by the build. Everything else was
	# already staged by the merge; an unstaged file here is an unexpected side effect.
	git add 'packages/ai/src/*.generated.ts' 'packages/ai/src/providers/*.models.ts' 2>/dev/null || true
	unexpected="$(unexpected_changes)"
	if [[ -n "$unexpected" ]]; then
		die "$(printf 'Unexpected build changes:\n%s' "$unexpected")"
	fi

	say "Running repository checks"
	if git diff --cached --name-only -- package-lock.json | grep -q .; then
		if ! git diff --cached --quiet main -- package-lock.json; then
			die "Merged package-lock.json differs from upstream/main. Review the dependency changes manually."
		fi
		allow_lockfile_change=1
	fi
	PI_ALLOW_LOCKFILE_CHANGE="$allow_lockfile_change" node scripts/check-lockfile-commit.mjs
	PI_ALLOW_LOCKFILE_CHANGE="$allow_lockfile_change" npm run check
	unexpected="$(unexpected_changes)"
	if [[ -n "$unexpected" ]]; then
		die "$(printf 'Repository checks modified tracked files:\n%s' "$unexpected")"
	fi

	say "Running focused fork checks"
	(
		cd packages/coding-agent
		npx vitest --run --maxWorkers=1 --pool=forks \
			test/footer-width.test.ts \
			test/model-selector.test.ts \
			test/model-resolver.test.ts \
			test/version-check.test.ts
	)
fi

if [[ "$already_current" -eq 0 ]]; then
	PI_ALLOW_LOCKFILE_CHANGE="$allow_lockfile_change" git commit -m "merge: sync upstream/main into local"
fi
trap - EXIT INT TERM

if [[ "$DO_PUSH" -eq 1 ]]; then
	git push --atomic origin main:main local:local
fi

say "Done"
if [[ "$already_current" -eq 0 ]]; then
	echo "local now contains upstream/main plus the fork patches. Backup: $backup"
elif [[ "$DO_TEST" -eq 1 ]]; then
	echo "local was already current and passed build/check validation."
else
	echo "local was already current; build/check validation was skipped (--no-test)."
fi
