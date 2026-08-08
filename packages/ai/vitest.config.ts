import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { boundedForkPool } from "../../scripts/vitest-pool.mjs";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		...boundedForkPool(),
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/pi-telemetry$/, replacement: telemetrySrcIndex }],
	},
});
