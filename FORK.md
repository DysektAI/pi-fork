# Fork maintenance guide

This repository is a fork of [`earendil-works/pi`](https://github.com/earendil-works/pi)
(`upstream`) published at `DysektAI/pi` (`origin`).

## Branch model

| Branch | Role |
| --- | --- |
| `main` | Mirror pointer for `upstream/main`; `fork-sync.sh` refreshes it. |
| `local` | The single long-lived fork branch: upstream plus all fork commits. Build and run this branch. |
| other branches | Temporary development branches. Merge them into `local`, then delete them. |

`.fork/fork-manifest.json` inventories fork patches so the drift checker can
report when upstream appears to have absorbed one. It does not control git
history or branch rebuilding.

## Releases and self-update

Fork source releases are built only from `local` and use the version format
`<upstream-version>+local.<N>`. They are published as GitHub releases in
`DysektAI/pi`; the workspace package versions remain at the upstream version.

A Pi process running from a verified fork source checkout follows only this
fork release channel. Verification requires the checkout to contain `.git`,
`.fork/local-version`, and the expected `packages/coding-agent/package.json`.
Its automatic version check queries the latest `DysektAI/pi` GitHub release and
never falls back to the upstream package feed.

For that source installation, `pi update --self` performs the consumer update:

1. Fetch `origin/local` into `refs/remotes/origin/local`.
2. Create `local` tracking `origin/local` if it does not exist (restricted-refspec clones).
3. Switch to `local`.
4. Fast-forward `local` to `origin/local` (fails safely if `local` has diverged).
5. Run `npm ci --ignore-scripts` at the repository root.
6. Rebuild the monorepo.

This source-checkout path is supported on Windows, macOS, and Linux when Git,
Node.js, and npm are available. It does not run `fork-sync.sh`, merge
`upstream/main`, install the private repository root through npm, or require a
release `.tgz` asset. The checkout must be clean enough for Git to switch and
fast-forward safely; failures stop and print the exact fallback command.

npm, pnpm, yarn, and Bun global installations are upstream package installs,
not fork source checkouts. They continue to use the published upstream package
channel. To run and self-update the fork, launch Pi from the `local` source
checkout, or through a global shim whose package directory links into the
checkout (a Windows directory junction or `npm link`); the link is resolved
and the checkout is detected the same way.

## Syncing with upstream

```bash
./fork-sync.sh             # merge upstream into local, build, test, push
./fork-sync.sh --no-push   # verify locally without pushing
./fork-sync.sh --no-test   # merge only
./fork-sync.sh --no-drift  # skip the absorbed-patch report
```

The script:

1. Requires a clean `local` checkout.
2. Fetches `upstream` and `origin`.
3. Moves the local `main` mirror to `upstream/main`.
4. Reports fork patches that upstream may have absorbed.
5. Tags the current `local` tip as `backup/sync-<timestamp>/local`.
6. Merges `main` into `local`.
7. Takes upstream versions of conflicted generated model catalogs, then
   regenerates them during the build.
8. Stops on genuine source overlap instead of guessing.
9. Builds, runs the focused fork checks, and commits the merge.
10. Atomically pushes the upstream mirror to `origin/main` and the fork result
    to `origin/local`, so either both validated refs advance or neither does.

This uses normal merge history: no routine rebases, branch reconstruction, or
force-pushes. A conflict is therefore tied to real overlapping edits, not to
maintenance machinery.

## Automation

Use one scheduler only. GitHub Actions is preferred because it is independent
of a workstation. The local systemd timer is a fallback and should be disabled
when the GitHub workflow is enabled.

The scheduler should run `./fork-sync.sh`. If it fails, inspect the conflicting
files, resolve them on `local`, complete the merge, run the checks, and push.
This is the maintainer path that integrates new upstream source and publishes a
validated `origin/local` for source installations to consume.

Do not substitute `pi update --self` for fork synchronization. Self-update only
fast-forwards a consumer checkout to the already-published `origin/local`; it
never fetches or merges `upstream/main`. Conversely, fork launchers that want
release notifications must not set `PI_SKIP_VERSION_CHECK=1`.

## Absorbed upstream features

Run:

```bash
python3 .fork/fork-drift-check.py
```

`REDUNDANT` is a review prompt, not automatic deletion. Confirm equivalent
upstream behavior, remove the fork implementation in a normal `local` commit,
and remove its manifest entry. No branch surgery is required.

## Adding or changing a fork feature

1. Branch from `local`: `git switch -c feat/my-feature local`.
2. Implement and test the change.
3. Merge it into `local`, then delete the temporary branch.
4. Add or update its drift probe in `.fork/fork-manifest.json`.
5. Run `./fork-sync.sh --no-push` before pushing.

Prefer Pi extensions, skills, settings, or packages over core patches whenever
they can provide the behavior. Every core patch is a potential future merge
conflict; extension-only customizations update independently.

## Recovery

Before every upstream merge, the script creates a backup tag. To abandon a bad
manual resolution:

```bash
git merge --abort
# or, after a completed bad merge (preserves later history):
git revert -m 1 <bad-merge-commit>
```

Check current divergence with:

```bash
git log --oneline local..upstream/main   # upstream commits not yet merged
git log --oneline upstream/main..local   # fork-only commits
```

## Local version tracking

`.fork/local-version` records a human-readable fork iteration marker:

```
0.82.0+local.1
```

Format: `<upstream-version>+local.<N>` where N is a monotonically
increasing counter reset to 1 after each upstream version bump.

The `+` before `local` is **required** — semver build metadata must be
separated by `+`. Never put the local suffix into any `package.json`
`"version"` field; those stay on the clean upstream version so `npm ci`
and other tooling parse them correctly.

To bump after local changes:
```bash
echo "$(sed 's/+local\.[0-9]*$//' .fork/local-version)+local.$(( $(sed 's/.*+local\.//' .fork/local-version) + 1 ))" > .fork/local-version
```

After a successful upstream sync that changes the base version, reset to 1:
```bash
echo "0.82.0+local.1" > .fork/local-version
```
