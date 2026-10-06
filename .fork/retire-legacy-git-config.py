#!/usr/bin/env python3
"""Remove only the retired fork CHANGELOG merge driver's Git registration."""

import subprocess
from pathlib import Path


def main():
    attribute_path = Path(subprocess.check_output(
        ["git", "rev-parse", "--git-path", "info/attributes"], text=True
    ).strip())
    if attribute_path.exists():
        original = attribute_path.read_bytes()
        retained = b"".join(line for line in original.splitlines(keepends=True)
                            if line.strip() != b"**/CHANGELOG.md merge=fork-changelog")
        if retained != original:
            attribute_path.write_bytes(retained)

    registration = subprocess.run(
        ["git", "config", "--local", "--get-regexp", r"^merge\.fork-changelog\."],
        stdout=subprocess.DEVNULL, check=False
    )
    if registration.returncode == 0:
        subprocess.run(["git", "config", "--local", "--remove-section", "merge.fork-changelog"], check=True)
    elif registration.returncode != 1:
        raise subprocess.CalledProcessError(registration.returncode, registration.args)


if __name__ == "__main__":
    main()
