import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { formatNoModelsAvailableMessage } from "../src/core/auth-guidance.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const cases = [
	{
		name: "restores a retired Copilot session through the supported provider default",
		savedModelId: "gpt-5.4",
		allowedModelIds: ["gpt-5.3-codex", "gpt-6.1-sol"],
		expectedModelId: "gpt-6.1-sol",
	},
	{
		name: "does not restore a catalogued session model excluded by the account allowlist",
		savedModelId: "gpt-6.1-sol",
		allowedModelIds: ["gpt-5.3-codex"],
		expectedModelId: "gpt-5.3-codex",
	},
	{
		name: "does not reselect an unavailable saved default after restoration fails",
		savedModelId: "gpt-6.1-sol",
		settingsModelId: "gpt-6.1-sol",
		allowedModelIds: ["gpt-5.3-codex"],
		expectedModelId: "gpt-5.3-codex",
	},
	{
		name: "preserves an authorized saved session model and high thinking level",
		savedModelId: "gpt-5.3-codex",
		settingsModelId: "gpt-6.1-sol",
		allowedModelIds: ["gpt-5.3-codex", "gpt-6.1-sol"],
		expectedModelId: "gpt-5.3-codex",
	},
	{
		name: "uses availability for a fresh session's saved settings default without rewriting preferences",
		settingsModelId: "gpt-6.1-sol",
		allowedModelIds: ["gpt-5.3-codex"],
		expectedModelId: "gpt-5.3-codex",
	},
	{
		name: "does not restore a catalogued model when the account allows no models",
		savedModelId: "gpt-6.1-sol",
		allowedModelIds: [],
		expectedModelId: undefined,
	},
	{
		name: "refreshes an uninitialized caller runtime before restoring an authorized saved model",
		savedModelId: "gpt-5.3-codex",
		settingsModelId: "gpt-6.1-sol",
		allowedModelIds: ["gpt-5.3-codex", "gpt-6.1-sol"],
		expectedModelId: "gpt-5.3-codex",
		refreshOnCreate: false,
	},
	{
		name: "refreshes stale caller availability before restoring a now-disallowed saved model",
		savedModelId: "gpt-6.1-sol",
		settingsModelId: "gpt-6.1-sol",
		initialAllowedModelIds: ["gpt-5.3-codex", "gpt-6.1-sol"],
		allowedModelIds: ["gpt-5.3-codex"],
		expectedModelId: "gpt-5.3-codex",
	},
	{
		name: "fails closed when refreshing caller-runtime availability fails",
		savedModelId: "gpt-6.1-sol",
		settingsModelId: "gpt-6.1-sol",
		allowedModelIds: ["gpt-5.3-codex", "gpt-6.1-sol"],
		expectedModelId: undefined,
		availabilityError: "Synthetic credential availability failure",
	},
	{
		name: "initializes availability for a fresh SDK session with a supplied runtime",
		settingsModelId: "gpt-5.3-codex",
		allowedModelIds: ["gpt-5.3-codex", "gpt-6.1-sol"],
		expectedModelId: "gpt-5.3-codex",
		refreshOnCreate: false,
	},
	{
		name: "preserves explicit caller models without checking automatic availability",
		settingsModelId: "gpt-5.3-codex",
		explicitModelId: "gpt-6.1-sol",
		allowedModelIds: ["gpt-5.3-codex"],
		expectedModelId: "gpt-6.1-sol",
		refreshOnCreate: false,
	},
];

// Regression for #45: automatic SDK restoration must use current account availability.
describe("SDK Copilot model restoration availability", () => {
	beforeAll(() => initTheme("dark", false));
	for (const fixture of cases) {
		test(fixture.name, async () => {
			const root = mkdtempSync(join(tmpdir(), "pi-sdk-copilot-"));
			const project = join(root, "project");
			const agentDir = join(root, "agent");
			mkdirSync(project);
			mkdirSync(agentDir);
			const settingsPath = join(agentDir, "settings.json");
			const modelsPath = join(agentDir, "models.json");
			const settings = `${JSON.stringify({
				defaultProvider: "github-copilot",
				defaultModel: fixture.settingsModelId,
				defaultThinkingLevel: "high",
				enabledModels: ["github-copilot/*", "offline-fixture/*"],
				modelThinkingLevels: { "github-copilot/gpt-5.3-codex": "high" },
			})}\n`;
			writeFileSync(settingsPath, settings);
			writeFileSync(modelsPath, "{}\n");
			const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Live requests are disabled"));
			let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
			let restoreAvailability: (() => void) | undefined;
			let restoreAvailableRead: (() => void) | undefined;
			try {
				const credentials = AuthStorage.inMemory({
					"github-copilot": {
						type: "oauth",
						access: "sdk-fixture-access",
						refresh: "sdk-fixture-refresh",
						expires: Date.now() + 3_600_000,
						availableModelIds: fixture.initialAllowedModelIds ?? fixture.allowedModelIds,
					},
				});
				const runtime =
					fixture.refreshOnCreate === false
						? await ModelRuntime.create({
								credentials,
								modelsPath,
								modelsStore: new InMemoryCodingAgentModelsStore(),
								allowModelNetwork: false,
								refreshOnCreate: false,
							})
						: getModelRuntime(await createModelRegistry(credentials, modelsPath));
				if (fixture.refreshOnCreate === false) {
					expect(runtime.getAvailableSnapshot()).toEqual([]);
					expect(
						runtime.getModel(
							"github-copilot",
							fixture.savedModelId ?? fixture.settingsModelId ?? fixture.explicitModelId!,
						),
					).toBeDefined();
				} else {
					const available = await runtime.getAvailable();
					expect(available.map((model) => model.id).sort()).toEqual(
						[...(fixture.initialAllowedModelIds ?? fixture.allowedModelIds)].sort(),
					);
				}
				if (fixture.initialAllowedModelIds) {
					await credentials.modify("github-copilot", async (current) => {
						if (!current || current.type !== "oauth") throw new Error("Missing synthetic OAuth credential");
						return { ...current, availableModelIds: fixture.allowedModelIds };
					});
					expect(await credentials.read("github-copilot")).toMatchObject({
						availableModelIds: fixture.allowedModelIds,
					});
					expect(
						runtime
							.getAvailableSnapshot()
							.map((model) => model.id)
							.sort(),
					).toEqual([...fixture.initialAllowedModelIds].sort());
				}
				if (fixture.savedModelId === "gpt-6.1-sol") {
					expect(runtime.getModel("github-copilot", fixture.savedModelId)).toBeDefined();
				}
				const manager = SessionManager.inMemory(project);
				if (fixture.savedModelId) {
					manager.appendModelChange("github-copilot", fixture.savedModelId);
					manager.appendThinkingLevelChange("high");
					manager.appendMessage({ role: "user", content: "Resume this synthetic session", timestamp: 1234 });
				}
				if (fixture.availabilityError) {
					const originalRead = credentials.read.bind(credentials);
					const failure = new Error(fixture.availabilityError);
					const read = vi.spyOn(credentials, "read").mockImplementation(async (providerId, options) => {
						if (providerId === "github-copilot") throw failure;
						return originalRead(providerId, options);
					});
					restoreAvailability = () => read.mockRestore();
				}
				const availability = vi.spyOn(runtime, "getAvailable");
				restoreAvailableRead = () => availability.mockRestore();
				const options: CreateAgentSessionOptions = {
					cwd: project,
					agentDir,
					modelRuntime: runtime,
					model: fixture.explicitModelId ? runtime.getModel("github-copilot", fixture.explicitModelId) : undefined,
					settingsManager: SettingsManager.create(project, agentDir),
					sessionManager: manager,
					resourceLoader: createTestResourceLoader(),
					noTools: "all",
				};
				if (fixture.availabilityError) {
					const pending = createAgentSession(options).then((result) => {
						session = result.session;
						return result;
					});
					await expect(pending).rejects.toThrow(fixture.availabilityError);
					return;
				}
				const result = await createAgentSession(options);
				session = result.session;
				if (fixture.explicitModelId) expect(availability).not.toHaveBeenCalled();
				if (fixture.expectedModelId) {
					expect(session.model?.id).toBe(fixture.expectedModelId);
				} else {
					// Agent core retains its no-model sentinel; the SDK must surface the existing guidance.
					expect(session.model?.id).toBe("unknown");
					expect(session.thinkingLevel).toBe("off");
					expect(result.modelFallbackMessage).toBe(formatNoModelsAvailableMessage());
				}
				if (fixture.savedModelId && fixture.expectedModelId && fixture.savedModelId !== fixture.expectedModelId) {
					expect(result.modelFallbackMessage).toBe(
						`Could not restore model github-copilot/${fixture.savedModelId}. Using github-copilot/${fixture.expectedModelId}`,
					);
				}
				if (fixture.savedModelId === fixture.expectedModelId) {
					expect(result.modelFallbackMessage).toBeUndefined();
					expect(session.thinkingLevel).toBe("high");
				}
			} finally {
				restoreAvailability?.();
				session?.dispose();
				restoreAvailableRead?.();
				const settingsAfter = readFileSync(settingsPath, "utf8");
				const modelsAfter = readFileSync(modelsPath, "utf8");
				const networkCalls = network.mock.calls.length;
				network.mockRestore();
				rmSync(root, { recursive: true, force: true });
				expect(settingsAfter).toBe(settings);
				expect(modelsAfter).toBe("{}\n");
				expect(networkCalls).toBe(0);
			}
		});
	}
});
