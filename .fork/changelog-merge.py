#!/usr/bin/env python3
"""Git merge driver: union-merge CHANGELOG.md for the fork.

Fork feature branches only ADD bullets under the `## [Unreleased]` section of a
CHANGELOG. Upstream periodically cuts releases, which reshuffles `[Unreleased]`
and breaks the textual anchor the fork bullets sat on, producing a conflict on
every rebase/merge after a release.

This driver is maintenance-free: it reads whatever bullets the fork side added
relative to the 3-way merge base, then re-inserts them under the matching
`### <subsection>` of the *current* `[Unreleased]` section, skipping any bullet
the other side already contains.

Configured as a git merge driver (see .fork/setup-fork.sh):

    [merge "fork-changelog"]
        name = fork CHANGELOG union
        driver = python3 .fork/changelog-merge.py %O %A %B %A %P

and mapped in .git/info/attributes (untracked, installed by setup-fork.sh):

    **/CHANGELOG.md merge=fork-changelog

Git invokes it automatically during merge, rebase, and cherry-pick. Arguments:
    %O = ancestor version (merge base)
    %A = current/ours version  (driver MUST overwrite this file with the result)
    %B = other/theirs version
    %P = real pathname of the file being merged (for diagnostics)

Exit 0 => resolved (git keeps %A). Exit non-zero => conflict left for the human.
"""

import sys


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().splitlines()
    except OSError as exc:
        sys.stderr.write(f"changelog-merge: cannot read {path}: {exc}\n")
        return None


def unreleased_bounds(lines):
    """Return (start, end) of the `## [Unreleased]` body, or None.

    start = index just after the heading; end = index of the next `## ` heading
    (or len(lines)).
    """
    start = None
    for i, ln in enumerate(lines):
        if ln.strip().startswith("## [Unreleased]"):
            start = i + 1
            break
    if start is None:
        return None
    end = len(lines)
    for j in range(start, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break
    return start, end


def parse_subsections(lines, start, end):
    """Map `### Heading` -> list of bullet lines, preserving document order.

    Bullets are lines beginning with '- '. Bullets before any `###` heading are
    filed under the empty-string key "".
    """
    sections = {}
    order = []
    current = ""
    sections[current] = []
    order.append(current)
    for ln in lines[start:end]:
        if ln.startswith("### "):
            current = ln[4:].strip()
            if current not in sections:
                sections[current] = []
                order.append(current)
        elif ln.startswith("- "):
            sections[current].append(ln)
    return sections, order


def fallback_to_ours(ours_lines, out_path):
    """When we cannot reason about structure, keep ours unchanged and succeed
    only if there is genuinely nothing to merge; otherwise signal conflict."""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(ours_lines) + "\n")


def main():
    if len(sys.argv) < 5:
        sys.stderr.write("usage: changelog-merge.py %O %A %B %A [%P]\n")
        return 2

    base_p, ours_p, theirs_p, out_p = sys.argv[1:5]
    base = read(base_p)
    ours = read(ours_p)
    theirs = read(theirs_p)
    if base is None or ours is None or theirs is None:
        return 1

    tb = unreleased_bounds(theirs)
    ob = unreleased_bounds(ours)
    if tb is None or ob is None:
        # One side has no [Unreleased]; let git produce a normal conflict so a
        # human decides. (Returning non-zero leaves %A as-is for git.)
        sys.stderr.write("changelog-merge: missing [Unreleased]; deferring to manual merge\n")
        return 1

    bb = unreleased_bounds(base)
    base_sections = {}
    if bb is not None:
        base_sections, _ = parse_subsections(base, *bb)

    theirs_sections, theirs_order = parse_subsections(theirs, *tb)

    # Fork-added bullets: present in theirs[Unreleased] subsection, absent from
    # the same subsection of base[Unreleased].
    added = {}
    for sec in theirs_order:
        base_bullets = set(base_sections.get(sec, []))
        new_bullets = [b for b in theirs_sections[sec] if b not in base_bullets]
        if new_bullets:
            added[sec] = new_bullets

    if not added:
        # Nothing fork-specific to carry; take ours verbatim.
        fallback_to_ours(ours, out_p)
        return 0

    out = list(ours)

    for sec, bullets in added.items():
        # Skip bullets already present anywhere in ours' [Unreleased].
        ob2 = unreleased_bounds(out)
        if ob2 is None:
            return 1
        s2, e2 = ob2
        ours_sections, _ = parse_subsections(out, s2, e2)
        existing = set()
        for v in ours_sections.values():
            existing.update(v)
        to_add = [b for b in bullets if b not in existing]
        if not to_add:
            continue

        if sec == "":
            insert_at = s2
            while insert_at < e2 and out[insert_at].strip() == "":
                insert_at += 1
            block = list(to_add)
            if insert_at < len(out) and out[insert_at].strip() != "":
                block = to_add + [""]
            out[insert_at:insert_at] = block
            continue

        head_idx = None
        for i in range(s2, e2):
            if out[i].startswith("### ") and out[i][4:].strip() == sec:
                head_idx = i
                break

        if head_idx is None:
            # Subsection missing in ours: create it just after [Unreleased].
            insert_at = s2
            while insert_at < e2 and out[insert_at].strip() == "":
                insert_at += 1
            out[insert_at:insert_at] = ["### " + sec, ""] + to_add + [""]
            continue

        # Append to the end of the existing subsection's bullet list.
        j = head_idx + 1
        last_bullet = head_idx
        while j < e2 and not out[j].startswith("## ") and not out[j].startswith("### "):
            if out[j].startswith("- "):
                last_bullet = j
            j += 1
        out[last_bullet + 1:last_bullet + 1] = to_add

    with open(out_p, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
