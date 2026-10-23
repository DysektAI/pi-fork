import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { zodResponseFormat } from "openai/helpers/zod";
import * as z from "zod/v4";

const readJson = (relativePath) => JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
const patchedVersion = "4.6.7";
const aiRequire = createRequire(new URL("../packages/ai/package.json", import.meta.url));
const { zodResponseFormat: aiZodResponseFormat } = aiRequire("openai/helpers/zod");

// DysektAI/pi-fork#50: test the installed parser, not just the lockfile version.
for (const collection of ["array", "set", "map"]) {
	test(`Zod rejects an oversized ${collection} before validating its elements`, () => {
		let visited = 0;
		const element = z.string().refine(() => {
			visited++;
			return true;
		});
		const values = ["one", "two", "three"];
		const schema =
			collection === "array"
				? z.array(element).max(2)
				: collection === "set"
					? z.set(element).max(2)
					: z.map(z.string(), element).check(z.maxSize(2));
		const input =
			collection === "array"
				? values
				: collection === "set"
					? new Set(values)
					: new Map(values.map((value) => [value, value]));
		const result = schema.safeParse(input);
		assert.equal(result.success, false);
		assert.equal(visited, 0, "size bounds must reject input before per-element work");
		assert.equal(result.error.issues.length, 1);
		assert.equal(result.error.issues[0].code, "too_big");
	});
}

// Cover source checkout, packaged installer, and independently installed example.
for (const manifestPath of [
	"package.json",
	"packages/coding-agent/package.json",
	"packages/coding-agent/install-lock/package.json",
	"packages/coding-agent/examples/extensions/sandbox/package.json",
]) {
	test(`${manifestPath} pins the patched Zod override`, () => {
		assert.equal(readJson(manifestPath).overrides?.zod, patchedVersion);
	});
}

for (const lockPath of [
	"package-lock.json",
	"packages/coding-agent/install-lock/package-lock.json",
	"packages/coding-agent/examples/extensions/sandbox/package-lock.json",
]) {
	test(`${lockPath} contains only patched Zod copies`, () => {
		const lock = readJson(lockPath);
		const entries = Object.entries(lock.packages).filter(([path]) => /(?:^|\/)node_modules\/zod$/.test(path));
		if (lockPath === "packages/coding-agent/install-lock/package-lock.json") {
			// The installer omits optional Zod peers today; any future copy must still be patched.
			assert.ok(lock.packages["node_modules/@earendil-works/pi-coding-agent"]);
		} else {
			assert.ok(entries.length > 0, "a missing dependency must not make this regression pass");
		}
		for (const [path, entry] of entries) assert.equal(entry.version, patchedVersion, path);
	});
}

test("the installer excludes private-example crypto and test-server dependencies", () => {
	const lock = readJson("packages/coding-agent/install-lock/package-lock.json");
	assert.ok(lock.packages["node_modules/@earendil-works/pi-coding-agent"]);
	for (const path of Object.keys(lock.packages)) {
		assert.doesNotMatch(path, /(?:^|\/)node_modules\/(?:node-forge|vite|vitest|@vitest\/mocker)$/);
	}
});

test("SDK helpers still generate and parse structured outputs offline", () => {
	const schema = z.object({ answer: z.string() });
	const anthropic = zodOutputFormat(schema);
	assert.equal(anthropic.type, "json_schema");
	assert.equal(anthropic.schema.properties.answer.type, "string");
	assert.deepEqual(anthropic.parse('{"answer":"yes"}'), { answer: "yes" });
	assert.throws(() => anthropic.parse('{"answer":1}'));

	// Eval tooling and pi-ai can resolve different OpenAI versions; cover both consumers.
	for (const format of [zodResponseFormat, aiZodResponseFormat]) {
		const openai = format(schema, "answer");
		assert.equal(openai.json_schema.strict, true);
		assert.equal(openai.json_schema.schema.properties.answer.type, "string");
		assert.deepEqual(openai.$parseRaw('{"answer":"yes"}'), { answer: "yes" });
		assert.throws(() => openai.$parseRaw('{"answer":1}'));
	}
});

test("sandbox configuration keeps its records, defaults, and restriction validation", () => {
	const config = {
		network: { allowedDomains: ["github.com", "*.npmjs.org"], deniedDomains: ["blocked.example.com"] },
		filesystem: { denyRead: ["/private"], allowWrite: ["/work"], denyWrite: ["/work/.env"] },
		ignoreViolations: { "*": ["/usr/bin"], "git push": ["/tmp"] },
	};
	assert.deepEqual(SandboxRuntimeConfigSchema.parse({ ...config, unknown: true }), config);
	assert.deepEqual(
		SandboxRuntimeConfigSchema.parse({
			network: { allowedDomains: [], deniedDomains: [] },
			filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
		}),
		{
			network: { allowedDomains: [], deniedDomains: [] },
			filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
		},
	);
	assert.equal(
		SandboxRuntimeConfigSchema.safeParse({ ...config, network: { allowedDomains: ["*"], deniedDomains: [] } })
			.success,
		false,
	);
	assert.equal(
		SandboxRuntimeConfigSchema.safeParse({ ...config, filesystem: { ...config.filesystem, denyRead: [""] } }).success,
		false,
	);
	assert.equal(
		SandboxRuntimeConfigSchema.safeParse({ ...config, network: { ...config.network, httpProxyPort: 65536 } }).success,
		false,
	);
	assert.equal(SandboxRuntimeConfigSchema.safeParse({ ...config, ignoreViolations: { "*": [1] } }).success, false);
});
