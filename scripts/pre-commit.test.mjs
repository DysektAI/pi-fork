import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

async function repository(t, files, { hookShell = "sh -e" } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-pre-commit-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const env = { ...process.env };
	for (const name of Object.keys(env)) {
		if (name.startsWith("GIT_") || name === "PI_ALLOW_LOCKFILE_CHANGE") delete env[name];
	}
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = join(root, "git-config");
	const realGit = spawnSync("sh", ["-c", "command -v git"], { env, encoding: "utf8" });
	assert.equal(realGit.status, 0, realGit.error?.message ?? realGit.stderr);
	env.HOOK_REAL_GIT = realGit.stdout.trimEnd();
	env.PATH = `${join(root, "bin")}${delimiter}${env.PATH}`;
	env.HOOK_COMMAND_LOG = join(root, "commands.log");
	await writeFile(env.GIT_CONFIG_GLOBAL, "");
	await writeFile(env.HOOK_COMMAND_LOG, "");

	function git(...args) {
		const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
		assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
		return result.stdout;
	}

	async function write(path, content) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), content);
	}

	git("init", "--quiet");
	git("config", "user.name", "Hook Test");
	git("config", "user.email", "hook-test@example.invalid");
	git("config", "core.autocrlf", "false");
	git("config", "core.hooksPath", ".git/hooks");
	for (const [path, content] of Object.entries(files)) await write(path, content);
	git("--literal-pathspecs", "add", "--", ...Object.keys(files));
	git("commit", "--quiet", "-m", "seed");

	await mkdir(join(root, ".husky"));
	await mkdir(join(root, "scripts"));
	await mkdir(join(root, "bin"));
	await copyFile(new URL("../.husky/pre-commit", import.meta.url), join(root, ".husky/pre-commit"));
	await copyFile(new URL("./check-lockfile-commit.mjs", import.meta.url), join(root, "scripts/check-lockfile-commit.mjs"));
	// Husky invokes the hook through sh -e; run the actual hook with the same error handling by default.
	await writeFile(join(root, ".git/hooks/pre-commit"), `#!/bin/sh\nPATH="$PWD/bin:$PATH"\nexport PATH\nexec ${hookShell} .husky/pre-commit\n`, { mode: 0o755 });
	await writeFile(join(root, "bin/npm"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOOK_COMMAND_LOG"
case "$*" in
  'run check')
    if [ -f formatter.mjs ]; then node formatter.mjs; fi
    exit "\${HOOK_CHECK_EXIT:-0}"
    ;;
  'run check:browser-smoke') exit "\${HOOK_BROWSER_EXIT:-0}" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });

	return {
		root,
		env,
		git,
		write,
		commit: () => spawnSync("git", ["commit", "-m", "exercise hook"], { cwd: root, env, encoding: "utf8" }),
		commands: async () => (await readFile(env.HOOK_COMMAND_LOG, "utf8")).trim().split("\n").filter(Boolean),
	};
}

function succeeded(result) {
	assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout + result.stderr, /All pre-commit checks passed!/);
}

// DysektAI/pi-fork#12: git rm --cached leaves an ignored file on disk after successful checks.
test("commits ignored untracking while leaving the file on disk", async (t) => {
	const repo = await repository(t, { "cache/entry": "blob\n", ".gitignore": "" });
	repo.git("rm", "--cached", "cache/entry");
	await repo.write(".gitignore", "cache/\n");
	repo.git("add", "--", ".gitignore");
	succeeded(repo.commit());
	assert.deepEqual(await repo.commands(), ["run check"]);
	assert.equal(repo.git("ls-files", "-z", "--", "cache/entry"), "");
	assert.equal(await readFile(join(repo.root, "cache/entry"), "utf8"), "blob\n");
});

// #12: skipping only ignored files would still undo deliberate untracking of ordinary files.
test("preserves staged deletions even when the files still exist and are not ignored", async (t) => {
	const repo = await repository(t, { "kept.txt": "blob\n", "deleted.txt": "gone\n" });
	repo.git("rm", "--cached", "--", "kept.txt");
	repo.git("rm", "--", "deleted.txt");
	succeeded(repo.commit());
	assert.equal(repo.git("ls-files", "-z"), "");
	assert.equal(await readFile(join(repo.root, "kept.txt"), "utf8"), "blob\n");
});

test("restages only previously staged additions and modifications using literal filenames", async (t) => {
	const names = ["a file.txt", "-leading.txt", "glob[1].txt", "unicode-\u00e9.txt"];
	if (process.platform !== "win32") names.push("tab\tfile.txt", "line\nfile.txt", 'quote"file.txt', ":literal.txt");
	const files = Object.fromEntries([...names, "unstaged.txt", "ignored-but-tracked.txt"].map((name) => [name, "original\n"]));
	const repo = await repository(t, { ...files, ".gitignore": "" });
	await repo.write(".gitignore", "ignored-but-tracked.txt\n");
	const staged = [...names, "added file.txt", "ignored-but-tracked.txt"];
	for (const name of staged) await repo.write(name, "staged\n");
	repo.git("--literal-pathspecs", "add", "--", ".gitignore", ...staged);
	await repo.write("formatter.mjs", `import { writeFileSync } from "node:fs";
for (const name of ${JSON.stringify([...staged, "unstaged.txt", "untracked.txt"])}) writeFileSync(name, "formatted\\n");
`);
	succeeded(repo.commit());
	for (const name of staged) assert.equal(repo.git("show", `HEAD:${name}`), "formatted\n");
	assert.equal(repo.git("show", "HEAD:unstaged.txt"), "original\n");
	assert.equal(repo.git("ls-files", "-z", "--", "untracked.txt", "formatter.mjs"), "");
	assert.equal(await readFile(join(repo.root, "unstaged.txt"), "utf8"), "formatted\n");
});

test("restages a renamed destination without re-adding an ignored source left on disk", async (t) => {
	const repo = await repository(t, { "old name.txt": "original\n", ".gitignore": "" });
	repo.git("mv", "--", "old name.txt", "new name.txt");
	await repo.write("old name.txt", "left behind\n");
	await repo.write(".gitignore", "old name.txt\n");
	repo.git("add", "--", ".gitignore");
	await repo.write("formatter.mjs", 'import { writeFileSync } from "node:fs"; writeFileSync("new name.txt", "formatted\\n");\n');
	succeeded(repo.commit());
	assert.equal(repo.git("show", "HEAD:new name.txt"), "formatted\n");
	assert.equal(repo.git("ls-files", "-z", "--", "old name.txt"), "");
});

for (const [label, path, failure, expectedCommands] of [
	["check", "source.txt", "HOOK_CHECK_EXIT", ["run check"]],
	["browser smoke", "packages/ai/a file.txt", "HOOK_BROWSER_EXIT", ["run check", "run check:browser-smoke"]],
]) {
	test(`aborts on a ${label} failure before restaging formatter changes`, async (t) => {
		const repo = await repository(t, { [path]: "original\n" });
		await repo.write(path, "staged\n");
		repo.git("--literal-pathspecs", "add", "--", path);
		await repo.write("formatter.mjs", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(path)}, "formatted\\n");\n`);
		repo.env[failure] = "23";
		const result = repo.commit();
		assert.equal(result.status, 1, result.stderr);
		assert.doesNotMatch(result.stdout + result.stderr, /All pre-commit checks passed!/);
		assert.deepEqual(await repo.commands(), expectedCommands);
		assert.equal(repo.git("show", `:${path}`), "staged\n");
		assert.equal(repo.git("show", `HEAD:${path}`), "original\n");
	});
}

// The hook must not rely on the caller's errexit: manual `sh .husky/pre-commit` runs abort too.
for (const hookShell of ["sh -e", "sh"]) {
	test(`does not suppress git add failures (${hookShell})`, async (t) => {
		const repo = await repository(t, { "source.txt": "original\n" }, { hookShell });
		await repo.write("source.txt", "staged\n");
		repo.git("add", "--", "source.txt");
		await writeFile(join(repo.root, "bin/git"), `#!/bin/sh
for arg do
  if [ "$arg" = add ]; then
    echo 'injected git add failure' >&2
    exit 17
  fi
done
exec "$HOOK_REAL_GIT" "$@"
`, { mode: 0o755 });
		const result = repo.commit();
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /injected git add failure/);
		assert.doesNotMatch(result.stdout + result.stderr, /All pre-commit checks passed!/);
		assert.equal(repo.git("show", "HEAD:source.txt"), "original\n");
	});
}

test("keeps the lockfile guard ahead of formatting and restaging", async (t) => {
	const repo = await repository(t, { "package-lock.json": "{}\n" });
	await repo.write("package-lock.json", '{"lockfileVersion":3}\n');
	repo.git("add", "--", "package-lock.json");
	const result = repo.commit();
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /Review lockfile changes before committing/);
	assert.deepEqual(await repo.commands(), []);
});
