import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

describe("ExtensionAPI.getExtensions", () => {
	it("returns loaded extensions with source metadata", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-extensions-api-"));
		try {
			const extensionPath = join(tempDir, ".pi/extensions/startup.ts");
			let seen: unknown;
			const extensionsResult = await createTestExtensionsResult([
				{
					path: extensionPath,
					factory: (pi) => {
						pi.on("context", () => {
							seen = pi.getExtensions();
						});
					},
				},
			]);
			extensionsResult.extensions[0].sourceInfo = {
				path: extensionPath,
				source: "local",
				scope: "project",
				origin: "top-level",
				baseDir: join(tempDir, ".pi/extensions"),
			};

			const session = new AgentSession({
				agent: new Agent({ initialState: { systemPrompt: "", tools: [] }, streamFn: streamSimple }),
				sessionManager: SessionManager.inMemory(),
				settingsManager: SettingsManager.create(tempDir, tempDir),
				cwd: tempDir,
				modelRuntime: await ModelRuntime.create({
					credentials: AuthStorage.create(join(tempDir, "auth.json")),
					modelsPath: null,
					allowModelNetwork: false,
				}),
				resourceLoader: createTestResourceLoader({ extensionsResult }),
			});

			await session.extensionRunner.emitContext([]);

			expect(seen).toEqual([
				{
					name: "startup",
					sourceInfo: {
						path: extensionPath,
						source: "local",
						scope: "project",
						origin: "top-level",
						baseDir: join(tempDir, ".pi/extensions"),
					},
				},
			]);
			session.dispose();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
