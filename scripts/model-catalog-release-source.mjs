import { join } from "node:path";

/** Archive the authoritative pi-ai release without trusting or changing the fork's refs. */
export function archiveReleaseSource(release, archive, temporaryDir, root, run) {
	const gitDir = join(temporaryDir, "release.git");
	run("git", ["init", "--bare", gitDir], root);
	run(
		"git",
		["--git-dir", gitDir, "fetch", "--depth=1", "https://github.com/earendil-works/pi.git", `refs/tags/v${release}`],
		root,
	);
	run("git", ["--git-dir", gitDir, "archive", "--prefix=release/", "--output", archive, "FETCH_HEAD"], root);
}
