import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Api, AuthOperationOptions, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getPackageDir } from "../src/config.ts";
import { resolveModelScope, resolveModelScopeWithDiagnostics } from "../src/core/model-resolver.ts";

const availableModel: Model<"openai-completions"> = {
	id: "available",
	name: "Available",
	api: "openai-completions",
	provider: "scope-fixture",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Deterministic availability-only fixture with no mutable catalogue or credential state. */
function createRuntime(models: readonly Model<Api>[]) {
	return {
		getAvailable: vi.fn(async () => models),
	} as unknown as Parameters<typeof resolveModelScope>[1];
}

/** Exercise real offline source startup with isolated preferences and no user configuration. */
function runCli(patterns: string[], args: string[] = []) {
	const root = mkdtempSync(join(tmpdir(), "pi-scope-warnings-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(projectDir);
	const settingsPath = join(agentDir, "settings.json");
	const settings = JSON.stringify({
		enabledModels: patterns,
		modelThinkingLevels: { "scope-fixture/available": "high" },
		defaultProvider: "scope-fixture",
		defaultModel: "available",
		defaultThinkingLevel: "low",
	});
	writeFileSync(settingsPath, settings);
	const modelsPath = join(agentDir, "models.json");
	const models = JSON.stringify({
		providers: {
			"scope-fixture": {
				api: availableModel.api,
				baseUrl: availableModel.baseUrl,
				apiKey: "scope-fixture-test-key",
				models: [{ id: availableModel.id, reasoning: availableModel.reasoning }],
			},
		},
	});
	writeFileSync(modelsPath, models);

	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(join(getPackageDir(), "src/experimental/source-resolver.ts")).href,
			join(getPackageDir(), "src/cli.ts"),
			"--offline",
			"--print",
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-approve",
			...args,
		],
		{
			cwd: projectDir,
			encoding: "utf8",
			timeout: 15000,
			env: {
				HOME: root,
				USERPROFILE: root,
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				NO_COLOR: "1",
			},
		},
	);

	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toBe("");
	expect(readFileSync(settingsPath, "utf8")).toBe(settings);
	expect(readFileSync(modelsPath, "utf8")).toBe(models);
	return result.stderr;
}

// #41: portable persisted scopes must not flood startup, but explicit mistakes stay actionable.
describe("model scope warning provenance", () => {
	it("summarizes 72 unavailable entries without changing the 73-entry scope or thinking level", async () => {
		const patterns = [
			...Array.from({ length: 72 }, (_, index) => `unavailable/model-${index}`),
			"scope-fixture/available:high",
		];
		const original = [...patterns];
		const runtime = createRuntime([availableModel]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const options = { signal: new AbortController().signal };

		const result = await resolveModelScope(patterns, runtime, options, "settings");

		expect(result).toEqual([{ model: availableModel, thinkingLevel: "high" }]);
		expect(patterns).toEqual(original);
		expect(vi.mocked(runtime.getAvailable)).toHaveBeenCalledWith(undefined, options);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("72 enabledModels entries do not match available models");
		expect(warn.mock.calls[0][0]).toContain("/scoped-models");
		expect(warn.mock.calls[0][0]).toContain("settings.json");
	});

	it.each([undefined, "cli"] as const)(
		"keeps individual warnings for explicit/default CLI source %s",
		async (source) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const result = await resolveModelScope(
				["missing-a", "available", "missing-b"],
				createRuntime([availableModel]),
				undefined,
				source,
			);

			expect(result).toEqual([{ model: availableModel, thinkingLevel: undefined }]);
			expect(warn).toHaveBeenCalledTimes(2);
			expect(warn.mock.calls[0][0]).toContain('No models match pattern "missing-a"');
			expect(warn.mock.calls[1][0]).toContain('No models match pattern "missing-b"');
		},
	);

	it("retains detailed invalid-thinking and ambiguity warnings beside the summary", async () => {
		const shared = { ...availableModel, id: "shared", name: "Shared" };
		const other = { ...shared, provider: "other-fixture" };
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await resolveModelScope(
			["missing-a", "available:invalid", "shared:high", "missing-*"],
			createRuntime([availableModel, shared, other]),
			undefined,
			"settings",
		);

		expect(result).toEqual([
			{ model: availableModel, thinkingLevel: undefined },
			{ model: shared, thinkingLevel: "high" },
			{ model: other, thinkingLevel: "high" },
		]);
		expect(warn).toHaveBeenCalledTimes(3);
		expect(warn.mock.calls[0][0]).toContain('Invalid thinking level "invalid"');
		expect(warn.mock.calls[1][0]).toContain("matches several providers");
		expect(warn.mock.calls[2][0]).toContain("2 enabledModels entries do not match available models");
	});

	it("keeps first-match ordering and duplicate handling without warning when every entry matches", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await resolveModelScope(
			["available:high", "available:low"],
			createRuntime([availableModel]),
			undefined,
			"settings",
		);

		expect(result).toEqual([{ model: availableModel, thinkingLevel: "high" }]);
		expect(warn).not.toHaveBeenCalled();
	});

	it("uses singular wording when a persisted scope has one unavailable entry", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await resolveModelScope(["missing"], createRuntime([]), undefined, "settings");

		expect(result).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("1 enabledModels entry does not match available models");
	});

	it("leaves the public structured diagnostics complete and console-free", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await resolveModelScopeWithDiagnostics(
			["missing-a", "available", "missing-b"],
			createRuntime([availableModel]),
		);

		expect(result.scopedModels).toEqual([{ model: availableModel, thinkingLevel: undefined }]);
		expect(result.diagnostics.map(({ code, pattern }) => ({ code, pattern }))).toEqual([
			{ code: "no-match", pattern: "missing-a" },
			{ code: "no-match", pattern: "missing-b" },
		]);
		expect(warn).not.toHaveBeenCalled();
	});

	it("propagates cancellation without replacing it with a scope notice", async () => {
		const controller = new AbortController();
		const cancelled = new Error("scope cancelled");
		controller.abort(cancelled);
		const runtime = {
			getAvailable: vi.fn((_type: unknown, options?: AuthOperationOptions) => {
				options?.signal?.throwIfAborted();
				return [];
			}),
		} as unknown as Parameters<typeof resolveModelScope>[1];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(resolveModelScope(["missing"], runtime, { signal: controller.signal }, "settings")).rejects.toBe(
			cancelled,
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it("propagates catalogue failures without replacing them with a scope notice", async () => {
		const failed = new Error("catalogue unavailable");
		const runtime = createRuntime([]);
		vi.mocked(runtime.getAvailable).mockRejectedValue(failed);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(resolveModelScope(["missing"], runtime, undefined, "settings")).rejects.toBe(failed);
		expect(warn).not.toHaveBeenCalled();
	});

	// #41: execute main.ts to prove the CLI passes settings/flag provenance, not just the resolver.
	it.each([true, false])("summarizes persisted scopes at real CLI startup with a match=%s", (hasMatch) => {
		const patterns = [
			...Array.from({ length: 72 }, (_, index) => `unavailable/model-${index}`),
			hasMatch ? "scope-fixture/available:high" : "unavailable/model-extra",
		];
		const stderr = runCli(patterns);

		expect(stderr).toContain(`${hasMatch ? 72 : 73} enabledModels entries do not match available models`);
		expect(stderr.match(/Warning:/g)).toHaveLength(1);
		expect(stderr).not.toContain("No models match pattern");
	});

	it("keeps explicit --models mistakes detailed and overrides the persisted scope for one invocation", () => {
		const stderr = runCli(["persisted-missing", "available"], ["--models", "cli-missing-a,available,cli-missing-b"]);

		expect(stderr.match(/Warning:/g)).toHaveLength(2);
		expect(stderr).toContain('No models match pattern "cli-missing-a"');
		expect(stderr).toContain('No models match pattern "cli-missing-b"');
		expect(stderr).not.toContain("persisted-missing");
		expect(stderr).not.toContain("enabledModels entries");
	});

	it("does not fall back to persisted entries for an explicitly empty --models scope", () => {
		const stderr = runCli(["persisted-missing", "available"], ["--models", ""]);

		expect(stderr).not.toContain("Warning:");
	});
});
