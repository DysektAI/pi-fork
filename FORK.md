# Fork maintenance guide

This repository is a fork of [`earendil-works/pi`](https://github.com/earendil-works/pi)
(remote `upstream`) published at `DysektAI/pi` (remote `origin`). It carries a
small set of local features on top of upstream and re-bases them onto each new
upstream release.

## Branch model

| Branch | Role |
| --- | --- |
| `main` | Pristine mirror of `upstream/main`. Never holds fork commits. |
| `feat/*` | One feature per branch. Some are stacked (see below). |
| `feat/fork-tooling` | Fork maintenance tooling (`.fork/`, `fork-sync.sh`, this doc). Merged into `local` like any other feature so it survives every rebuild. |
| `local` | `main` + every `feat/*` merged. This is the branch you build and run. |

Stacked features:

- `feat/markdown-path-linkify` stacks on `feat/theme-toolpath-color`.
- `feat/footer-thinking-level-color` stacks on `feat/max-thinking-level`.
- `feat/theme-missing-token-warning` needs both `feat/max-thinking-level` and
  `feat/theme-toolpath-color`.

## First-time setup (per clone)

```bash
./.fork/setup-fork.sh
```

This is idempotent and only touches local git state:

- Registers the `fork-changelog` merge driver in `.git/config`.
- Maps `**/CHANGELOG.md` to that driver in `.git/info/attributes` (untracked,
  so nothing fork-specific lands in the upstream-owned `.gitattributes`).
- Enables `rerere` with autoupdate, so any conflict you resolve by hand is
  replayed automatically the next time it recurs.

## Syncing with upstream

```bash
./fork-sync.sh             # full sync + rebuild + bounded tests
./fork-sync.sh --no-push   # do everything locally, skip pushing to origin
./fork-sync.sh --no-test   # skip the build + test step
```

The script fast-forwards `main` to `upstream/main`, rebases each feature branch,
rebuilds the stacked branches, and rebuilds `local`. It creates backup tags
(`backup/sync-<timestamp>/*`) before rewriting history and uses
`--force-with-lease` for all pushes.

## Why CHANGELOG conflicts no longer stop the sync

Fork features only *add* bullets under `## [Unreleased]`. When upstream cuts a
release it reshuffles that section, which used to conflict on every rebase. The
`.fork/changelog-merge.py` merge driver resolves this automatically during
merge, rebase, and cherry-pick: it carries the fork's added bullets onto the new
`[Unreleased]` structure and skips anything upstream already shipped. It is
maintenance-free — no hardcoded changelog text.

If you ever hit a genuinely new conflict (a real code conflict in a feature),
the script aborts and tells you which branch to fix:

```bash
git switch <branch>
git rebase main          # resolve, then:
git add <files>
git rebase --continue
```

Because `rerere` is enabled, resolving it once records the resolution for next
time.

## Adding or changing a feature

1. Branch from `main`: `git switch -c feat/my-feature main`.
2. Keep the feature self-contained; add a CHANGELOG bullet under `[Unreleased]`.
3. Add the branch to the appropriate array in `fork-sync.sh`
   (`INDEPENDENT_BRANCHES` or the stacked logic, and `LOCAL_MERGE_BRANCHES`).
4. Run `./fork-sync.sh --no-push` to verify it rebuilds and tests cleanly.

## Checking what the fork carries vs upstream

```bash
git fetch upstream
git log --oneline upstream/main..local        # everything the fork adds
git log --oneline main..upstream/main         # new upstream commits to absorb
```
