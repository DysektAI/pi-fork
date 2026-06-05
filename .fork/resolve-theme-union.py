#!/usr/bin/env python3
"""Resolve recurring ThemeColor / theme.ts union conflicts for the fork.

Several fork features add members to the same TypeScript string-literal unions
in theme.ts (e.g. `| "thinkingMax"`, `| "bashMode"`, `| "toolPath"`). When two
or more are combined, git produces a conflict (sometimes nested) in the union.
The correct resolution is always the UNION of all added members, preserving the
surrounding non-conflicting lines.

This resolver rewrites the given file in place: for every conflict region it
finds (including nested markers), it collects the distinct lines from all sides
and emits them once, in first-seen order. It only acts when every line inside
the conflict is a union member (`| "..."`), a blank line, or a trailing `;`
marker line; otherwise it leaves the conflict untouched and reports failure so a
human resolves it.

Usage:
    resolve-theme-union.py FILE
Exit 0 if the file is now free of conflict markers, 1 otherwise.
"""

import re
import sys

MARKER = re.compile(r"^(<<<<<<<|=======|>>>>>>>)")
UNION_MEMBER = re.compile(r'^\s*\|\s*"[^"]+"\s*;?\s*$')


def is_union_ish(line):
    s = line.strip()
    return s == "" or s == ";" or UNION_MEMBER.match(line) is not None


def collect_union_lines(block_lines):
    """From the raw lines of a conflict region (markers stripped), return the
    distinct union-member lines in first-seen order, plus whether a trailing
    semicolon was present on any member."""
    seen = []
    seen_set = set()
    has_semi = False
    for ln in block_lines:
        if MARKER.match(ln):
            continue
        if ln.strip() == "":
            continue
        member = ln.rstrip()
        ends_semi = member.endswith(";")
        if ends_semi:
            has_semi = True
            member = member[:-1].rstrip()
        key = member.strip()
        if key not in seen_set:
            seen_set.add(key)
            seen.append(member)
    return seen, has_semi


def resolve(text):
    lines = text.splitlines()
    out = []
    i = 0
    n = len(lines)
    changed = False
    while i < n:
        if not lines[i].startswith("<<<<<<<"):
            out.append(lines[i])
            i += 1
            continue
        # Find the end of this (possibly nested) conflict: scan until markers
        # balance out at the matching closing >>>>>>>.
        depth = 0
        j = i
        region = []
        while j < n:
            if lines[j].startswith("<<<<<<<"):
                depth += 1
            elif lines[j].startswith(">>>>>>>"):
                depth -= 1
                region.append(lines[j])
                j += 1
                if depth == 0:
                    break
                continue
            region.append(lines[j])
            j += 1
        # region spans lines[i:j]; verify every non-marker line is union-ish.
        body = [ln for ln in region if not MARKER.match(ln)]
        if not body or not all(is_union_ish(ln) for ln in body):
            # Not a pure union conflict; leave it for manual resolution.
            out.extend(region)
            i = j
            continue
        members, has_semi = collect_union_lines(region)
        if not members:
            out.extend(region)
            i = j
            continue
        # Emit the union; reattach a single trailing semicolon to the last one
        # if any side had it.
        for k, m in enumerate(members):
            if has_semi and k == len(members) - 1:
                out.append(m + ";")
            else:
                out.append(m)
        changed = True
        i = j
    return "\n".join(out) + "\n", changed


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: resolve-theme-union.py FILE\n")
        return 2
    path = argv[1]
    with open(path, encoding="utf-8") as f:
        text = f.read()
    resolved, changed = resolve(text)
    if changed:
        with open(path, "w", encoding="utf-8") as f:
            f.write(resolved)
    # Success only if no conflict markers remain.
    if re.search(r"(?m)^(<<<<<<<|=======|>>>>>>>)", resolved):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
