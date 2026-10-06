import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// DysektAI/pi-fork#23: audit must launch on Windows and fail closed on tool/report errors.
const script = fileURLToPath(new URL("./npm-audit.mjs", import.meta.url));

async function audit(t, report, status = 0) {
	const root = await mkdtemp(join(tmpdir(), "pi audit "));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cli = join(root, "npm-cli.js");
	await writeFile(cli, `
const assert = require("node:assert/strict");
assert.deepEqual(process.argv.slice(2), ["audit", "--omit=dev", "--json"]);
process.stdout.write(${JSON.stringify(typeof report === "string" ? report : JSON.stringify(report))});
process.exit(${status});
`);
	return spawnSync(process.execPath, [script], {
		cwd: root,
		env: { ...process.env, npm_execpath: cli, PATH: "" },
		encoding: "utf8",
	});
}

function report(vulnerabilities = {}) {
	return { vulnerabilities, metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } } };
}

test("runs the npm JavaScript CLI without a shell or npm on PATH", async (t) => {
	const result = await audit(t, report());
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /No unaccepted advisories/);
});

test("rejects an unaccepted advisory", async (t) => {
	const result = await audit(t, report({ bad: { via: [{ name: "bad", severity: "high", url: "https://example.test/GHSA-new", title: "bad", range: "*" }] } }), 1);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Found 1 unaccepted advisories/);
});

test("preserves the documented package-specific exception", async (t) => {
	const via = { name: "node-forge", severity: "high", url: "https://github.com/advisories/GHSA-86w9-cpqp-85rv" };
	const result = await audit(t, report({ "node-forge": { via: [via] }, gondolin: { via: ["node-forge"] } }), 1);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Accepted GHSA-86w9-cpqp-85rv/);
	const wrongPackage = await audit(t, report({ other: { via: [{ ...via, name: "other" }] } }), 1);
	assert.equal(wrongPackage.status, 1);
});

for (const [name, value, status] of [
	["tool failure", report(), 2],
	["empty report", {}, 0],
	["invalid JSON", "not JSON", 0],
	["API error", { error: { summary: "registry unavailable" } }, 1],
	["failed audit without findings", report(), 1],
	["failed audit with empty advisory lists", report({ bad: { via: [] } }), 1],
	["failed audit with only package references", report({ bad: { via: ["other"] } }), 1],
	["unknown advisory severity", report({ bad: { via: [{ severity: "unknown" }] } }), 1],
]) {
	test(`fails closed on ${name}`, async (t) => {
		const result = await audit(t, value, status);
		assert.notEqual(result.status, 0);
		assert.doesNotMatch(result.stdout, /No unaccepted advisories/);
	});
}
