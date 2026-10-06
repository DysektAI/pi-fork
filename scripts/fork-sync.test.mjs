import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

async function repository(t, { upstream = false, conflict = false, buildExit = 42, mutation = "mixed" } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-fork-sync-"));
	t.after(() => {
		assert.ok(root.startsWith(join(tmpdir(), "pi-fork-sync-")));
		return rm(root, { recursive: true, force: true });
	});
	const env = { ...process.env };
	for (const name of Object.keys(env)) {
		if (name.startsWith("GIT_") || name.startsWith("FORK_SYNC_")) delete env[name];
	}
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = join(root, "git-config");
	await writeFile(env.GIT_CONFIG_GLOBAL, "");
	let shellPath = "bash";
	if (process.platform === "win32") {
		const shell = spawnSync("git", ["var", "GIT_SHELL_PATH"], { cwd: root, env, encoding: "utf8" });
		assert.equal(shell.status, 0, shell.error?.message ?? shell.stderr);
		shellPath = join(dirname(shell.stdout.trim()), "bash.exe");
	}
	function git(...args) {
		const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
		assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
		return result.stdout.trim();
	}
	git("init", "--quiet", "--initial-branch=local");
	git("config", "user.name", "Sync Test");
	git("config", "user.email", "sync-test@example.invalid");
	git("config", "core.autocrlf", "false");
	git("config", "core.hooksPath", ".git/hooks");
	await writeFile(join(root, ".gitignore"), "bin/\ngit-config\ncommands.log\n");
	for (const file of ["tracked.txt", "staged.txt"]) await writeFile(join(root, file), "seed\n");
	await copyFile(new URL("../fork-sync.sh", import.meta.url), join(root, "fork-sync.sh"));
	await mkdir(join(root, ".fork"));
	await copyFile(new URL("../.fork/retire-legacy-git-config.py", import.meta.url), join(root, ".fork/retire-legacy-git-config.py"));
	await mkdir(join(root, "scripts"));
	await copyFile(new URL("./check-lockfile-commit.mjs", import.meta.url), join(root, "scripts/check-lockfile-commit.mjs"));
	git("add", "--", ".gitignore", "tracked.txt", "staged.txt", "fork-sync.sh", "scripts/check-lockfile-commit.mjs", ".fork/retire-legacy-git-config.py");
	git("commit", "--quiet", "-m", "seed");
	git("branch", "main");
	if (upstream || conflict) {
		git("switch", "--quiet", "main");
		await writeFile(join(root, conflict ? "tracked.txt" : "upstream.txt"), "upstream\n");
		git("add", "--", conflict ? "tracked.txt" : "upstream.txt");
		git("commit", "--quiet", "-m", "upstream");
		git("switch", "--quiet", "local");
	}
	if (conflict) {
		await writeFile(join(root, "tracked.txt"), "fork\n");
		git("add", "--", "tracked.txt");
		git("commit", "--quiet", "-m", "fork");
	}
	git("remote", "add", "upstream", ".");
	git("remote", "add", "origin", ".");
	await mkdir(join(root, "bin"));
	await writeFile(join(root, "bin/npm"), `#!/bin/sh
printf '%s\\n' "$*" >> commands.log
case "$*" in
  'run build')
    ${mutation === "mixed" ? "printf 'concurrent tracked edit\\n' > tracked.txt" : ""}
    ${mutation !== "untracked" ? "printf 'concurrent staged edit\\n' > staged.txt\n    git add -- staged.txt" : ""}
    ${mutation !== "staged" ? "printf 'concurrent untracked work\\n' > user-note.txt" : ""}
    exit ${buildExit}
    ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
	const head = git("rev-parse", "HEAD");
	return {
		root,
		git,
		head,
		run: (options = ["--no-drift", "--no-push"]) =>
			spawnSync(shellPath, [
				"-c",
				'PATH="$PWD/bin:/usr/bin:$PATH"; export PATH; exec "$BASH" ./fork-sync.sh "$@"',
				"fork-sync-test",
				...options,
			], { cwd: root, env, encoding: "utf8" }),
	};
}

test("retires the old driver registration without changing unrelated Git state, and is idempotent", async (t) => {
	const repo = await repository(t);
	const attributes = join(repo.root, ".git/info/attributes");
	await writeFile(attributes, "*.txt text eol=lf\r\n**/CHANGELOG.md merge=fork-changelog\r\n*.keep linguist-generated\r\n");
	repo.git("config", "merge.fork-changelog.name", "fork CHANGELOG union");
	repo.git("config", "merge.fork-changelog.driver", "retired-driver");
	repo.git("config", "merge.custom.driver", "custom-driver");
	repo.git("config", "rerere.enabled", "true");
	repo.git("config", "rerere.autoupdate", "false");
	await mkdir(join(repo.root, ".git/rr-cache/local-resolution"), { recursive: true });
	const resolution = join(repo.root, ".git/rr-cache/local-resolution/postimage");
	await writeFile(resolution, "local resolution\n");
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = repo.run(["--no-drift", "--no-push", "--no-test"]);
		assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
		assert.equal(repo.git("check-attr", "merge", "--", "packages/ai/CHANGELOG.md"), "packages/ai/CHANGELOG.md: merge: unspecified");
		assert.equal(repo.git("config", "--local", "--get-regexp", "^merge\\."), "merge.custom.driver custom-driver");
		assert.equal(await readFile(attributes, "utf8"), "*.txt text eol=lf\r\n*.keep linguist-generated\r\n");
		assert.equal(repo.git("config", "rerere.enabled"), "true");
		assert.equal(repo.git("config", "rerere.autoupdate"), "false");
		assert.equal(await readFile(resolution, "utf8"), "local resolution\n");
	}
});

for (const upstream of [false, true]) {
	for (const buildExit of [42, 0]) {
		test(`preserves concurrent work after ${buildExit ? "build failure" : "unexpected build changes"} with upstream ${upstream ? "ahead" : "current"}`, async (t) => {
			const repo = await repository(t, { upstream, buildExit });
			const result = repo.run();
			assert.equal(result.status, buildExit || 1, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
			assert.match(result.stdout, /Building/);
			assert.equal(await readFile(join(repo.root, "tracked.txt"), "utf8"), "concurrent tracked edit\n");
			assert.equal(await readFile(join(repo.root, "user-note.txt"), "utf8"), "concurrent untracked work\n");
			assert.equal(repo.git("show", ":staged.txt"), "concurrent staged edit");
			assert.equal(repo.git("rev-parse", "HEAD"), repo.head);
			assert.equal(await readFile(join(repo.root, "commands.log"), "utf8"), "run build\n");
			if (upstream) assert.equal(repo.git("rev-parse", "MERGE_HEAD"), repo.git("rev-parse", "main"));
		});
	}
}

for (const mutation of ["staged", "untracked"]) {
	test(`rejects ${mutation}-only concurrent work before checking or committing an upstream merge`, async (t) => {
		const repo = await repository(t, { upstream: true, buildExit: 0, mutation });
		const result = repo.run();
		assert.equal(result.status, 1, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /Unexpected build changes/);
		assert.equal(await readFile(join(repo.root, "commands.log"), "utf8"), "run build\n");
		assert.equal(repo.git("rev-parse", "HEAD"), repo.head);
		assert.equal(repo.git("rev-parse", "MERGE_HEAD"), repo.git("rev-parse", "main"));
		if (mutation === "staged") assert.equal(repo.git("show", ":staged.txt"), "concurrent staged edit");
		else assert.equal(await readFile(join(repo.root, "user-note.txt"), "utf8"), "concurrent untracked work\n");
	});
}

test("leaves genuine conflicts available for manual resolution", async (t) => {
	const repo = await repository(t, { conflict: true });
	const result = repo.run();
	assert.equal(result.status, 1, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
	assert.match(result.stderr, /Upstream overlaps fork code/);
	assert.equal(repo.git("rev-parse", "MERGE_HEAD"), repo.git("rev-parse", "main"));
	assert.match(repo.git("ls-files", "--unmerged"), /tracked.txt/);
	assert.equal(repo.git("rev-parse", "HEAD"), repo.head);
});

for (const upstream of [false, true]) {
	test(`completes an explicit merge-only sync with upstream ${upstream ? "ahead" : "current"}`, async (t) => {
		const repo = await repository(t, { upstream });
		const result = repo.run(["--no-drift", "--no-push", "--no-test"]);
		assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
		assert.equal(repo.git("status", "--porcelain"), "");
		if (upstream) {
			assert.equal(repo.git("rev-parse", "HEAD^1"), repo.head);
			assert.equal(repo.git("rev-parse", "HEAD^2"), repo.git("rev-parse", "main"));
		} else {
			assert.equal(repo.git("rev-parse", "HEAD"), repo.head);
		}
	});
}
