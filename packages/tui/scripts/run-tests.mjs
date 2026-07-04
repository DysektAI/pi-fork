import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveMaxForks } from "../../../scripts/vitest-pool.mjs";

/**
 * Runs the tui package's tests with Node's built-in test runner while bounding
 * concurrency. Node defaults to one test process per CPU; on high-core machines
 * (and under WSL) that can storm the host. The cap is shared with the Vitest
 * packages via `resolveMaxForks()` and is overridable with `VITEST_MAX_FORKS`.
 */

const concurrency = resolveMaxForks();
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const testFiles = [];
for await (const entry of glob("test/*.test.ts", { cwd: packageRoot })) {
	testFiles.push(entry);
}
testFiles.sort();

if (testFiles.length === 0) {
	console.error("No test files found under test/*.test.ts");
	process.exit(1);
}

const args = ["--test", `--test-concurrency=${concurrency}`, ...testFiles];

const child = spawn(process.execPath, args, {
	stdio: "inherit",
	cwd: packageRoot,
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
