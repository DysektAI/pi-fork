# Fork maintenance guide

This repository is a fork of [`earendil-works/pi`](https://github.com/earendil-works/pi)
(remote `upstream`) published at `DysektAI/pi` (remote `origin`). It carries a
small set of local features on top of upstream and re-bases them onto each new
upstream release.

## Branch model

| Branch | Role |
| --- | --- |
| `main` | Pristine mirror of `upstream/main`. Never holds fork commits. |
| `feat/*`, `fix/*`, `deps/*`, `test/*`, `refactor/*` | One feature/change per branch. Some are stacked (see below). |
| `feat/fork-tooling` | Fork maintenance tooling (`.fork/`, `fork-sync.sh`, this doc). Merged into `local` like any other feature so it survives every rebuild. |
| `local` | `main` + every merged feature. This is the branch you build and run. |

Features are declared in `.fork/fork-manifest.json` — the single source of
truth. `fork-sync.sh` derives its branch lists from it, so adding or removing a
feature means editing the manifest, not the script.

Current features (see the manifest for the authoritative list):

- `feat/theme-toolpath-color` — optional `toolPath` theme token
- `feat/max-thinking-level` — adds the `max` thinking level
- `feat/markdown-codeblock-border-style` — configurable code block borders
- `feat/test-bounded-pool` — caps vitest/Node test worker concurrency
- `feat/markdown-path-linkify` — linkify file paths in markdown (stacked)
- `feat/footer-thinking-level-color` — colored footer thinking indicator (stacked)
- `feat/theme-missing-token-warning` — warn on themes missing tokens (stacked)
- `deps/upgrade-vitest-4` — vitest 4.x security upgrade (GHSA-5xrq-8626-4rwp)
- `fix/improve-error-handling` — stderr-based error surfacing, stack traces
- `test/add-unit-tests-coverage` — unit tests for untested modules
- `refactor/deduplicate-shared-utils` — dedup shared agent/coding-agent utils

Stacked features (recorded via `stackedOn` in the manifest):

- `feat/markdown-path-linkify` stacks on `feat/theme-toolpath-color`.
- `feat/footer-thinking-level-color` stacks on `feat/max-thinking-level`.
- `feat/theme-missing-token-warning` needs both `feat/max-thinking-level` and
  `feat/theme-toolpath-color`.

## First-time setup (per clone)

```bash
./.fork/setup-fork.sh
```

This is idempotent and only touches local git state:

- Copies `.fork/changelog-merge.py` into `.git/fork/` so the driver is reachable
  no matter which branch is checked out (the tracked `.fork/` copy only lives on
  `feat/fork-tooling`, which is absent during feature rebases).
- Registers the `fork-changelog` merge driver in `.git/config`.
- Maps `**/CHANGELOG.md` to that driver in `.git/info/attributes` (untracked,
  so nothing fork-specific lands in the upstream-owned `.gitattributes`).
- Enables `rerere` with autoupdate, so any conflict you resolve by hand is
  replayed automatically the next time it recurs.

`fork-sync.sh` runs this automatically at the start of every sync, so the driver
is always installed before the first feature rebase.

## Syncing with upstream

```bash
./fork-sync.sh             # full sync + rebuild + bounded tests
./fork-sync.sh --no-push   # do everything locally, skip pushing to origin
./fork-sync.sh --no-test   # skip the build + test step
./fork-sync.sh --no-drift  # skip the upstream drift check
```

The script fast-forwards `main` to `upstream/main`, runs the drift check,
rebases each feature branch, rebuilds the stacked branches, and rebuilds
`local`. It creates backup tags (`backup/sync-<timestamp>/*`) before rewriting
history and uses `--force-with-lease` for all pushes.

## Dropping features upstream has absorbed

To avoid maintaining patches upstream already shipped, every feature in the
manifest carries a `drift` probe. `fork-sync.sh` runs the drift check after
fetching upstream, and you can run it any time:

```bash
python3 .fork/fork-drift-check.py            # report against upstream/main
python3 .fork/fork-drift-check.py --ref TAG  # test against a specific ref
```

Each feature is reported as:

- **ACTIVE** — upstream still lacks it; keep maintaining it.
- **REDUNDANT** — upstream appears to have absorbed it; review for removal.
- **CHECK** — upstream structure changed enough that the probe can't decide.

Probe types (declared per feature in the manifest):

- `grep-absent` / `grep-present` — pattern (not) present in a file at the ref.
- `path-absent` / `path-present` — a file (not) present at the ref.
- `version-gte` — a dependency version at/above a threshold (e.g. vitest >= 4.1.0).

When a feature is REDUNDANT and you confirm upstream covers it, drop it:

```bash
# 1. remove its entry from .fork/fork-manifest.json
# 2. delete the local + remote branch
git branch -D <branch>
git push origin --delete <branch>
# 3. re-run ./fork-sync.sh --no-push to rebuild local without it
```

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
time. Recurring genuine conflicts are also committed to the repo under
`.fork/rr-cache/` and restored by `setup-fork.sh`, so they auto-resolve on a
fresh clone too. Currently recorded:

- `theme.ts` ThemeColor union (features add `thinkingMax`, `bashMode`,
  `toolPath` to the same union) — also auto-unioned by
  `.fork/resolve-theme-union.py` as a backstop.
- `main.ts` interactive startup warnings (`feat/theme-missing-token-warning`
  and `fix/improve-error-handling` both add a warning after `initTheme`; the
  resolution keeps both).
- `footer-width.test.ts` import union (`feat/footer-thinking-level-color` adds
  `theme`; upstream's cache-hit-rate test adds `stripAnsi`). The footer
  cherry-pick block in `fork-sync.sh` auto-continues once rerere replays this.
- `settings-manager.ts` import union (`feat/markdown-codeblock-border-style`
  adds the `CodeBlockBorderStyle` type import; upstream adds `randomUUID`).
- `core/index.ts` export union (`fix/improve-error-handling` adds
  `EventBusErrorHandler`; upstream adds the `areExperimentalFeaturesEnabled`
  export).
- `changelog.test.ts` add/add (upstream ships its own suite for
  `normalizeChangelogLinks`; `test/add-unit-tests-coverage` adds suites for
  `parseChangelog`/`compareVersions`/`getNewEntries`). The resolution keeps both
  and renames the fork's local `entry` helper to `makeEntry` to avoid colliding
  with upstream's top-level `entry` constant.
- `compaction/utils.ts` (`refactor/deduplicate-shared-utils` replaces the inline
  implementation with re-exports from `@earendil-works/pi-agent-core`; upstream
  edits the inline `serializeConversation`). The resolution keeps the re-export
  form — agent-core's implementation is equivalent (it uses `safeJsonStringify`).
- `main.ts` import line (`feat/theme-missing-token-warning` adds
  `getThemeMissingTokenWarning`; upstream restructured this region). The
  resolution keeps `getThemeMissingTokenWarning` and drops the now-unused
  `ExtensionSelectorComponent` import upstream replaced with `showStartupSelector`.

If you change one of those features and the recorded resolution goes stale,
delete the matching entry under `.fork/rr-cache/`, re-resolve once, and copy the
new `.git/rr-cache/<hash>/{preimage,postimage}` back into `.fork/rr-cache/`.

## Adding or changing a feature

1. Branch from `main`: `git switch -c feat/my-feature main`.
2. Keep the feature self-contained; add a CHANGELOG bullet under `[Unreleased]`.
3. Add an entry to `.fork/fork-manifest.json` with a `drift` probe and, if it
   depends on another feature, a `stackedOn` key. Set `mergeIntoLocal: true`
   for leaf branches that should land in `local`.
4. Run `./fork-sync.sh --no-push` to verify it rebuilds and tests cleanly.

## Checking what the fork carries vs upstream

```bash
git fetch upstream
git log --oneline upstream/main..local        # everything the fork adds
git log --oneline main..upstream/main         # new upstream commits to absorb
```
