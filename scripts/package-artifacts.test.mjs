import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import { normalizePackResult, produceArtifactSet, readArtifactSet } from "./package-artifacts.mjs";

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), contents);
	}
}

test("npm pack accepts array and keyed results and rejects malformed entries", () => {
	const packed = { filename: "fixture-1.0.0.tgz", files: [{ path: "package.json" }], size: 100, unpackedSize: 200 };
	for (const result of [[packed], { fixture: packed }]) {
		assert.deepEqual(normalizePackResult(JSON.stringify(result), "fixture"), packed);
	}
	for (const result of [null, [], {}, [packed, packed], [null], [{ ...packed, files: null }], [{ ...packed, filename: "../fixture.tgz" }]]) {
		assert.throws(() => normalizePackResult(JSON.stringify(result), "fixture"), /unexpected result for fixture/);
	}
});

test("a missing Windows drive fails without looping while resolving ancestors", { skip: process.platform !== "win32" }, (t) => {
	const drive = [..."ZYXWVUTSRQPONMLKJIHGFED"].find((letter) => !existsSync(`${letter}:\\`));
	if (!drive) return t.skip("No missing drive is available");
	const moduleUrl = new URL("./package-artifacts.mjs", import.meta.url).href;
	const script = `import { produceArtifactSet } from ${JSON.stringify(moduleUrl)}; produceArtifactSet({ repoRoot: ${JSON.stringify(process.cwd())}, outDir: ${JSON.stringify(`${drive}:\\pi-missing-drive-test`)}, build: false, source: null });`;
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 1_000 });
	assert.equal(result.error, undefined);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Cannot resolve output directory ancestor/);
});

test("force rejects linked output paths before deleting package contents", (t) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-package-artifacts-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const repoRoot = join(temporaryRoot, "repo");
	const victim = join(repoRoot, "packages", "victim");
	mkdirSync(victim, { recursive: true });
	const marker = join(victim, "marker.txt");
	writeFileSync(marker, "preserve me");
	symlinkSync(join(repoRoot, "packages"), join(repoRoot, ".artifacts"), process.platform === "win32" ? "junction" : "dir");
	symlinkSync(repoRoot, join(temporaryRoot, "repo-alias"), process.platform === "win32" ? "junction" : "dir");
	symlinkSync(temporaryRoot, join(temporaryRoot, "ancestor-alias"), process.platform === "win32" ? "junction" : "dir");
	for (const outDir of [join(repoRoot, ".artifacts", "victim"), join(temporaryRoot, "repo-alias"), join(temporaryRoot, "ancestor-alias")]) {
		assert.throws(
			() => produceArtifactSet({ repoRoot, outDir, force: true, build: false, source: {} }),
			/Output directory.*(?:symbolic link|repository, its ancestor, or a filesystem root)/,
		);
		assert.equal(readFileSync(marker, "utf8"), "preserve me");
	}
});

test("force cannot replace the system temporary directory", (t) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-package-artifacts-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const repoRoot = join(temporaryRoot, "repo");
	const systemTemp = join(temporaryRoot, "system-temp");
	mkdirSync(repoRoot);
	mkdirSync(systemTemp);
	const marker = join(systemTemp, "marker.txt");
	writeFileSync(marker, "preserve system temp");
	const environment = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
	try {
		for (const key of Object.keys(environment)) process.env[key] = systemTemp;
		assert.equal(tmpdir(), systemTemp);
		assert.throws(
			() => produceArtifactSet({ repoRoot, outDir: systemTemp, force: true, build: false, source: null }),
			/system temporary directory/,
		);
		assert.equal(readFileSync(marker, "utf8"), "preserve system temp");
	} finally {
		for (const [key, value] of Object.entries(environment)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("failed packing removes only automatically allocated output", (t) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-package-artifacts-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const repoRoot = join(temporaryRoot, "repo");
	writePackage(join(repoRoot, "packages", "invalid"), { version: "1.0.0" }, {});
	const environment = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
	for (const key of Object.keys(environment)) process.env[key] = temporaryRoot;
	t.after(() => {
		for (const [key, value] of Object.entries(environment)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const before = readdirSync(tmpdir()).filter((name) => name.startsWith("pi-package-artifacts-"));
	assert.throws(() => produceArtifactSet({ repoRoot, build: false, source: {} }), /Command failed/);
	assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith("pi-package-artifacts-")), before);
	const outDir = join(temporaryRoot, "explicit-output");
	assert.throws(() => produceArtifactSet({ repoRoot, outDir, build: false, source: {} }), /Command failed/);
	assert.equal(existsSync(join(outDir, "tarballs")), true);
});

// #10633: Covers npm 12's package-keyed `npm pack --json` output only when npm 12 is on PATH.
test("produces a verified, content-addressed artifact set", (t) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-package-artifacts-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const repoRoot = join(temporaryRoot, "repo with spaces");
	mkdirSync(repoRoot);
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	writePackage(
		join(repoRoot, "packages", "shared"),
		{ name: "@pi-package-test/shared", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const marker = "artifact";\n' },
	);
	writePackage(
		join(repoRoot, "packages", "target"),
		{ name: "@pi-package-test/target", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const target = true;\n' },
	);
	execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
	execFileSync("git", ["add", "."], { cwd: repoRoot });
	execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repoRoot });

	const artifactSet = produceArtifactSet({ build: false, outDir: join(repoRoot, ".artifacts", "package set"), repoRoot });
	assert.deepEqual(artifactSet.packages.map((pkg) => pkg.name), ["@pi-package-test/shared", "@pi-package-test/target"]);
	for (const pkg of artifactSet.packages) {
		assert.match(pkg.tarball, /-[0-9a-f]{12}\.tgz$/);
		assert.match(pkg.integrity, /^sha512-/);
	}
	assert.equal(artifactSet.source.dirty, false);
	assert.equal(readArtifactSet(artifactSet.manifestPath).packages.length, 2);

	writeFileSync(join(repoRoot, "packages/shared/dist/index.js"), 'export const marker = "changed";\n');
	const changedArtifactSet = produceArtifactSet({ build: false, outDir: join(repoRoot, ".artifacts", "changed package set"), repoRoot });
	assert.notEqual(
		changedArtifactSet.getPackage("@pi-package-test/shared").tarball,
		artifactSet.getPackage("@pi-package-test/shared").tarball,
	);

	appendFileSync(artifactSet.packages[0].tarballPath, "corrupt");
	assert.throws(() => readArtifactSet(artifactSet.manifestPath), /integrity mismatch/);
	const packageJsonPath = join(repoRoot, "packages", "shared", "package.json");
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: join(repoRoot, "packages", "shared"), repoRoot }),
		/Repository-local output directory must be inside.*\.artifacts/,
	);
	assert.equal(existsSync(packageJsonPath), true);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: repoRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: temporaryRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: parse(repoRoot).root, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
});
