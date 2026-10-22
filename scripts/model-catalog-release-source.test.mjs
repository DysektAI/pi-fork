import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { archiveReleaseSource } from "./model-catalog-release-source.mjs";

const release = "1.4.0";
const repository = "https://github.com/earendil-works/pi.git";

function fixture(t, { localTag = false, upstreamTag = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-release-source-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "fork");
	const upstream = join(dir, "upstream");
	const archive = join(dir, "release.tar");
	const env = {
		HOME: dir,
		USERPROFILE: dir,
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		TMPDIR: dir,
		TMP: dir,
		TEMP: dir,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(dir, "nonexistent-gitconfig"),
		GIT_ALLOW_PROTOCOL: "file",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `url.${pathToFileURL(upstream).href}.insteadOf`,
		GIT_CONFIG_VALUE_0: repository,
		GIT_AUTHOR_NAME: "Release source test",
		GIT_AUTHOR_EMAIL: "release-source@example.invalid",
		GIT_COMMITTER_NAME: "Release source test",
		GIT_COMMITTER_EMAIL: "release-source@example.invalid",
	};
	const run = (command, args, cwd) => {
		const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
		return result.stdout;
	};
	for (const [checkout, payload, tag] of [
		[root, "fork source", localTag],
		[upstream, "upstream released source", upstreamTag],
	]) {
		mkdirSync(checkout);
		run("git", ["init", "--quiet"], checkout);
		writeFileSync(join(checkout, "source.txt"), payload);
		run("git", ["add", "source.txt"], checkout);
		run("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture source"], checkout);
		if (tag) run("git", ["tag", `v${release}`], checkout);
	}
	return { dir, root, archive, run };
}

// #44: a fork's refs are not authoritative for the upstream npm package being checked.
test("archives the authoritative release when the fork has no upstream tag", (t) => {
	const { dir, root, archive, run } = fixture(t);
	assert.doesNotThrow(() => archiveReleaseSource(release, archive, dir, root, run));
	assert.equal(run("tar", ["xOf", archive, "release/source.txt"], root), "upstream released source");
	assert.equal(run("git", ["tag", "--list"], root), "");
});

test("does not trust or overwrite a conflicting local release tag", (t) => {
	const { dir, root, archive, run } = fixture(t, { localTag: true });
	const localRef = run("git", ["rev-parse", `v${release}`], root);
	archiveReleaseSource(release, archive, dir, root, run);
	assert.equal(run("tar", ["xOf", archive, "release/source.txt"], root), "upstream released source");
	assert.equal(run("git", ["rev-parse", `v${release}`], root), localRef);
});

test("fails closed when the authoritative release tag is missing despite a local tag", (t) => {
	const { dir, root, archive, run } = fixture(t, { localTag: true, upstreamTag: false });
	assert.throws(
		() => archiveReleaseSource(release, archive, dir, root, run),
		/couldn't find remote ref refs\/tags\/v1\.4\.0/,
	);
});

// #44: changes to the extracted helper must not bypass released-consumer validation.
test("release-source edits trigger released-consumer compatibility CI", () => {
	const workflow = parse(
		readFileSync(new URL("../.github/workflows/publish-model-catalog.yml", import.meta.url), "utf8"),
	);
	const patterns = workflow.on.pull_request.paths;
	assert.ok(Array.isArray(patterns) && patterns.length > 0);
	for (const changedPath of [
		"scripts/check-model-catalog-compat.mjs",
		"scripts/model-catalog-release-source.mjs",
		"scripts/model-catalog-release-source.test.mjs",
	]) {
		assert.ok(
			patterns.some((pattern) => matchesGlob(changedPath, pattern)),
			`${changedPath} must trigger released-consumer validation`,
		);
	}
});
