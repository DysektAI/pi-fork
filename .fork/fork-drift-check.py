#!/usr/bin/env python3
"""Evaluate fork-feature drift against upstream.

Reads .fork/fork-manifest.json and, for each feature, runs its declared "drift"
probe against the upstream ref (default: upstream/main). Reports whether each
feature is still needed (ACTIVE) or appears to have been absorbed upstream
(REDUNDANT), so the fork does not maintain patches upstream already shipped.

Probe types:
  grep-absent    ACTIVE if pattern is NOT found in <file> at <ref> (still needed);
                 REDUNDANT if found.
  grep-present   REDUNDANT if pattern IS found in <file> at <ref>; else ACTIVE.
  path-absent    ACTIVE if <path> does NOT exist at <ref>; REDUNDANT if it does.
  path-present   REDUNDANT if <path> exists at <ref>; else ACTIVE.
  version-gte    REDUNDANT if the semver at <jsonPath> in <file> >= <minVersion>.

Exit codes:
  0  no features are REDUNDANT (nothing to drop)
  3  at least one feature is REDUNDANT (review for removal)
  2  usage / manifest / probe error

Usage:
  fork-drift-check.py [--manifest PATH] [--ref upstream/main] [--quiet]
"""

import json
import re
import subprocess
import sys
from pathlib import Path


C_RESET = "\033[0m"
C_GREEN = "\033[1;32m"
C_YELLOW = "\033[1;33m"
C_RED = "\033[1;31m"
C_CYAN = "\033[1;36m"
C_DIM = "\033[2m"


def git_show(ref, path):
    """Return file contents at <ref>:<path>, or None if it does not exist."""
    try:
        return subprocess.run(
            ["git", "show", f"{ref}:{path}"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except subprocess.CalledProcessError:
        return None


def git_path_exists(ref, path):
    return (
        subprocess.run(
            ["git", "cat-file", "-e", f"{ref}:{path}"],
            capture_output=True,
        ).returncode
        == 0
    )


def parse_semver(text):
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text)
    if not m:
        return None
    return tuple(int(x) for x in m.groups())


def json_dig(obj, dotted):
    cur = obj
    for key in dotted.split("."):
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def evaluate(probe, ref, ref_overridden):
    """Return (status, detail) where status in {ACTIVE, REDUNDANT, CHECK, ERROR}.

    When ref_overridden is True (caller passed --ref), that ref wins over any
    per-probe ref so the whole manifest can be tested against one ref.
    """
    ptype = probe.get("type")
    pref = ref if ref_overridden else probe.get("ref", ref)

    if ptype in ("grep-absent", "grep-present"):
        content = git_show(pref, probe["file"])
        if content is None:
            # File vanished upstream: structure changed enough to warrant review.
            return "CHECK", f"{probe['file']} not found at {pref}"
        found = re.search(probe["pattern"], content) is not None
        if ptype == "grep-absent":
            return ("REDUNDANT" if found else "ACTIVE",
                    f"/{probe['pattern']}/ {'found' if found else 'absent'} in {probe['file']}")
        return ("REDUNDANT" if found else "ACTIVE",
                f"/{probe['pattern']}/ {'found' if found else 'absent'} in {probe['file']}")

    if ptype in ("path-absent", "path-present"):
        exists = git_path_exists(pref, probe["path"])
        if ptype == "path-absent":
            return ("REDUNDANT" if exists else "ACTIVE",
                    f"{probe['path']} {'exists' if exists else 'absent'} at {pref}")
        return ("REDUNDANT" if exists else "ACTIVE",
                f"{probe['path']} {'exists' if exists else 'absent'} at {pref}")

    if ptype == "version-gte":
        content = git_show(pref, probe["file"])
        if content is None:
            return "CHECK", f"{probe['file']} not found at {pref}"
        try:
            data = json.loads(content)
        except json.JSONDecodeError as exc:
            return "ERROR", f"cannot parse {probe['file']}: {exc}"
        raw = json_dig(data, probe["jsonPath"])
        if raw is None:
            return "CHECK", f"{probe['jsonPath']} missing in {probe['file']}"
        have = parse_semver(str(raw))
        want = parse_semver(probe["minVersion"])
        if have is None or want is None:
            return "CHECK", f"unparseable version: have={raw} want={probe['minVersion']}"
        return ("REDUNDANT" if have >= want else "ACTIVE",
                f"upstream vitest {raw} {'>=' if have >= want else '<'} {probe['minVersion']}")

    return "ERROR", f"unknown probe type: {ptype}"


def main(argv):
    manifest_path = Path(".fork/fork-manifest.json")
    ref_arg = None
    quiet = False
    args = list(argv[1:])
    while args:
        a = args.pop(0)
        if a == "--manifest":
            manifest_path = Path(args.pop(0))
        elif a == "--ref":
            ref_arg = args.pop(0)
        elif a == "--quiet":
            quiet = True
        else:
            sys.stderr.write(f"unknown arg: {a}\n")
            return 2

    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"cannot read manifest {manifest_path}: {exc}\n")
        return 2

    ref = ref_arg or manifest.get("upstreamRef", "upstream/main")
    ref_overridden = bool(ref_arg)

    if not quiet:
        print(f"{C_CYAN}Fork drift check against {ref}{C_RESET}")
        print(f"{C_DIM}(REDUNDANT = upstream may have absorbed this; review for removal){C_RESET}\n")

    redundant, checks, errors = [], [], []
    width = max((len(f["branch"]) for f in manifest["features"]), default=10)

    for feat in manifest["features"]:
        status, detail = evaluate(feat["drift"], ref, ref_overridden)
        if status == "ACTIVE":
            color, label = C_GREEN, "ACTIVE"
        elif status == "REDUNDANT":
            color, label = C_YELLOW, "REDUNDANT"
            redundant.append(feat["branch"])
        elif status == "CHECK":
            color, label = C_YELLOW, "CHECK"
            checks.append(feat["branch"])
        else:
            color, label = C_RED, "ERROR"
            errors.append(feat["branch"])
        if not quiet:
            print(f"  {color}{label:<9}{C_RESET} {feat['branch']:<{width}}  {C_DIM}{detail}{C_RESET}")

    if not quiet:
        print()
        if redundant:
            print(f"{C_YELLOW}{len(redundant)} feature(s) look REDUNDANT — consider dropping:{C_RESET}")
            for b in redundant:
                print(f"    - {b}")
            print(f"{C_DIM}  Remove from .fork/fork-manifest.json, then delete the branch.{C_RESET}")
        if checks:
            print(f"{C_YELLOW}{len(checks)} feature(s) need a manual CHECK (upstream structure changed).{C_RESET}")
        if errors:
            print(f"{C_RED}{len(errors)} probe error(s) — fix the manifest.{C_RESET}")
        if not (redundant or checks or errors):
            print(f"{C_GREEN}All features ACTIVE. Nothing to drop.{C_RESET}")

    if errors:
        return 2
    if redundant:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
