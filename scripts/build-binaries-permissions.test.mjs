import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";

// DysektAI/pi-fork#17: a job-level permissions map replaces workflow defaults.
test("binary smoke tests grant checkout read access without write access", async () => {
	const workflow = load(await readFile(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8"));
	const job = workflow.jobs["smoke-test-binaries"];
	assert.ok(job, "smoke-test-binaries job must exist");
	assert.ok(job.steps.some((step) => step.uses?.startsWith("actions/checkout@")));
	const permissions = job.permissions ?? workflow.permissions;
	assert.equal(permissions.contents, "read", "checkout of SOURCE_REF needs contents: read");
	assert.equal(permissions.actions, "read", "downloading build artifacts needs actions: read");
	assert.ok(Object.values(permissions).every((access) => access === "read" || access === "none"));
});
