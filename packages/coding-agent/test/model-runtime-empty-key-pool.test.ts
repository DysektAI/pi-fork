import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

let poolDir: string | undefined;
afterEach(() => {
	vi.unstubAllGlobals();
	if (poolDir) rmSync(poolDir, { recursive: true });
	poolDir = undefined;
});

describe("empty API key pools", () => {
	it("skips network refresh, retains baseline models, and resumes when a key becomes available", async () => {
		const fetch = vi.fn(async () => new Response("[]", { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		poolDir = mkdtempSync(join(tmpdir(), "pi-empty-key-pool-"));
		const keyFile = join(poolDir, "key");
		writeFileSync(keyFile, "");
		const store = new InMemoryCodingAgentModelsStore();
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			modelsStore: store,
			refreshOnCreate: false,
		});
		runtime.registerProvider("zai", { apiKey: `!cat "${keyFile.replace(/\\/g, "/")}"` });
		const cached = {
			models: runtime
				.getProvider("zai")!
				.getModels()
				.map((model) => ({ ...model, name: "Cached model" })),
			lastModified: Number.MAX_SAFE_INTEGER,
		};
		await store.write("zai", cached);
		const baseline = runtime
			.getProvider("zai")!
			.getModels()
			.map((model) => model.id);

		const empty = await runtime.refresh({ providers: ["zai"], allowNetwork: true, force: true });
		expect(empty.errors.size).toBe(0);
		expect(fetch).not.toHaveBeenCalled();
		expect(
			runtime
				.getProvider("zai")!
				.getModels()
				.map((model) => model.id),
		).toEqual(baseline);
		expect(await runtime.getAuth("zai")).toBeUndefined();
		expect(runtime.getProvider("zai")!.getModels()[0]?.name).toBe("Cached model");
		expect(await store.read("zai")).toEqual(cached);

		writeFileSync(keyFile, "test-key");
		const recovered = await runtime.refresh({ providers: ["zai"], allowNetwork: true, force: true });
		expect(recovered.errors.size).toBe(0);
		expect(fetch).toHaveBeenCalledOnce();
		expect((await runtime.getAuth("zai"))?.auth.apiKey).toBe("test-key");
	});

	it("keeps a failing credential command visible and does not fetch", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerProvider("zai", { apiKey: "!exit 1" });
		const result = await runtime.refresh({ providers: ["zai"], allowNetwork: true });
		expect(result.errors.get("zai")?.message).toContain("Failed to resolve API key");
		expect(fetch).not.toHaveBeenCalled();
	});
});
