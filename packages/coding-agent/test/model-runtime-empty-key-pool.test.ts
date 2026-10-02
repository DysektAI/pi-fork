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
		expect(await runtime.checkAuth("zai")).toBeUndefined();
		expect(await runtime.getAvailable("zai")).toEqual([]);
		expect(runtime.hasConfiguredAuth("zai")).toBe(false);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "zai")).toBe(false);
		expect(runtime.getProvider("zai")!.getModels()[0]?.name).toBe("Cached model");
		expect(await store.read("zai")).toEqual(cached);
		await runtime.refresh({ providers: ["zai"], allowNetwork: false });
		expect(await runtime.checkAuth("zai")).toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();

		writeFileSync(keyFile, "test-key");
		const recovered = await runtime.refresh({ providers: ["zai"], allowNetwork: true, force: true });
		expect(recovered.errors.size).toBe(0);
		expect(fetch).toHaveBeenCalledOnce();
		expect((await runtime.getAuth("zai"))?.auth.apiKey).toBe("test-key");
		expect(runtime.hasConfiguredAuth("zai")).toBe(true);
		expect((await runtime.getAvailable("zai")).length).toBeGreaterThan(0);
	});

	it("invalidates observed emptiness when the command changes or is removed", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerProvider("zai", { apiKey: "!printf ''" });
		await runtime.getAuth("zai");
		expect(await runtime.checkAuth("zai")).toBeUndefined();
		runtime.registerProvider("zai", { apiKey: "!printf test-key" });
		expect(await runtime.checkAuth("zai")).toBeDefined();
		runtime.registerProvider("zai", { apiKey: "!printf ''" });
		expect(await runtime.checkAuth("zai")).toBeDefined();
		await runtime.getAuth("zai");
		runtime.unregisterProvider("zai");
		runtime.registerProvider("zai", { apiKey: "!printf ''" });
		// Unknown command output stays provisionally configured without executing the command.
		expect(await runtime.checkAuth("zai")).toBeDefined();
	});

	it("lets a stored credential override observed empty command output", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		runtime.registerProvider("zai", { apiKey: "!printf ''" });
		await runtime.getAuth("zai");
		await credentials.modify("zai", async () => ({ type: "api_key", key: "stored-key" }));
		expect(await runtime.checkAuth("zai")).toBeDefined();
		expect((await runtime.getAuth("zai"))?.auth.apiKey).toBe("stored-key");
		await credentials.delete("zai");
		await runtime.setRuntimeApiKey("zai", "runtime-key");
		expect((await runtime.getAuth("zai"))?.auth.apiKey).toBe("runtime-key");
		expect(runtime.hasConfiguredAuth("zai")).toBe(true);
		await runtime.removeRuntimeApiKey("zai");
		expect(runtime.hasConfiguredAuth("zai")).toBe(false);
	});

	it("isolates empty-pool observations between providers and runtimes", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerProvider("zai", { apiKey: "!printf ''" });
		await runtime.getAuth("zai");
		runtime.registerProvider("deepseek", { apiKey: "!printf ''" });
		expect(await runtime.checkAuth("zai")).toBeUndefined();
		expect(await runtime.checkAuth("deepseek")).toBeDefined();
		const other = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		other.registerProvider("zai", { apiKey: "!printf ''" });
		expect(await other.checkAuth("zai")).toBeDefined();
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

	it.each(["!printf ''", "!exit 1", "$PI_EMPTY_POOL_REQUIRED_HEADER"])(
		"reports an invalid required header with an empty key pool: %s",
		async (header) => {
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				refreshOnCreate: false,
			});
			runtime.registerProvider("zai", { apiKey: "!printf ''", headers: { "x-required": header } });
			const result = await runtime.refresh({ providers: ["zai"], allowNetwork: true });
			expect(result.errors.get("zai")?.message).toContain('provider "zai" header "x-required"');
			await expect(runtime.getAuth("zai")).rejects.toThrow('provider "zai" header "x-required"');
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("accepts a request-scoped required header while the key pool is empty", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerProvider("zai", {
			apiKey: "!printf ''",
			headers: { "x-required": "$PI_EMPTY_POOL_REQUIRED_HEADER" },
		});
		await expect(
			runtime.getAuth("zai", { env: { PI_EMPTY_POOL_REQUIRED_HEADER: "header-value" } }),
		).resolves.toBeUndefined();
	});
});
