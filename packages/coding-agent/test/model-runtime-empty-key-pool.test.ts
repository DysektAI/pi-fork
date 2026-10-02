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
	vi.restoreAllMocks();
	if (poolDir) rmSync(poolDir, { recursive: true });
	poolDir = undefined;
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

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
		expect(runtime.getProviderAuthStatus("zai")).toEqual({ configured: false });
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

	it("synchronizes direct key lookup transitions without a refresh and preserves empty registration state", async () => {
		poolDir = mkdtempSync(join(tmpdir(), "pi-empty-key-pool-"));
		const keyFile = join(poolDir, "key");
		writeFileSync(keyFile, "test-key");
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerProvider("zai", { apiKey: `!cat "${keyFile.replace(/\\/g, "/")}"` });
		await runtime.getAuth("zai");
		expect(runtime.hasConfiguredAuth("zai")).toBe(true);
		writeFileSync(keyFile, "");
		const model = runtime.getModels("zai")[0]!;
		expect(await runtime.getAuth(model)).toBeUndefined();
		expect(runtime.hasConfiguredAuth("zai")).toBe(false);
		expect(runtime.getProviderAuthStatus("zai")).toEqual({ configured: false });
		expect(runtime.getAvailableSnapshot().some((entry) => entry.provider === "zai")).toBe(false);
		runtime.registerProvider("zai", { name: "Updated provider name" });
		expect(runtime.hasConfiguredAuth("zai")).toBe(false);
		expect(runtime.getProviderAuthStatus("zai")).toEqual({ configured: false });
		writeFileSync(keyFile, "recovered-key");
		expect((await runtime.getAuth("zai"))?.auth.apiKey).toBe("recovered-key");
		expect(runtime.hasConfiguredAuth("zai")).toBe(true);
		expect(runtime.getProviderAuthStatus("zai").configured).toBe(true);
		expect(runtime.getAvailableSnapshot().some((entry) => entry.provider === "zai")).toBe(true);
	});

	it("keeps the latest empty observation when direct lookups overlap", async () => {
		poolDir = mkdtempSync(join(tmpdir(), "pi-empty-key-pool-"));
		const keyFile = join(poolDir, "key");
		writeFileSync(keyFile, "");
		const credentials = AuthStorage.inMemory();
		const read = credentials.read.bind(credentials);
		const firstRead = deferred();
		const availabilityRead = deferred();
		const availabilityStarted = deferred();
		let blockReads = false;
		let reads = 0;
		vi.spyOn(credentials, "read").mockImplementation(async (providerId, options) => {
			if (blockReads && providerId === "zai") {
				const count = ++reads;
				if (count === 1) await firstRead.promise;
				// Two auth lookups precede the three reads in the newer availability pass.
				if (count === 5) {
					availabilityStarted.resolve();
					await availabilityRead.promise;
				}
			}
			return read(providerId, options);
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		runtime.registerProvider("zai", { apiKey: `!cat "${keyFile.replace(/\\/g, "/")}"` });
		await runtime.refresh({ providers: ["zai"], allowNetwork: false });
		await runtime.getAuth("zai");
		expect(runtime.hasConfiguredAuth("zai")).toBe(false);
		blockReads = true;
		const firstLookup = runtime.getAuth("zai");
		writeFileSync(keyFile, "test-key");
		const secondLookup = runtime.getAuth("zai");
		try {
			await availabilityStarted.promise;
			// Let the available-model and auth checks observe the nonempty pool before publication.
			await new Promise<void>((resolve) => setImmediate(resolve));
			writeFileSync(keyFile, "");
			firstRead.resolve();
			expect(await firstLookup).toBeUndefined();
			availabilityRead.resolve();
			await secondLookup;
		} finally {
			firstRead.resolve();
			availabilityRead.resolve();
		}
		expect(await runtime.checkAuth("zai")).toBeUndefined();
		expect(runtime.hasConfiguredAuth("zai")).toBe(false);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "zai")).toBe(false);
	});

	it("preserves a required header error when availability synchronization also fails", async () => {
		const credentials = AuthStorage.inMemory();
		const read = credentials.read.bind(credentials);
		let failReads = false;
		let reads = 0;
		vi.spyOn(credentials, "read").mockImplementation(async (providerId, options) => {
			if (failReads && providerId === "zai" && ++reads >= 2) {
				throw new Error("availability credential read failed");
			}
			return read(providerId, options);
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		runtime.registerProvider("zai", { apiKey: "!printf ''", headers: { "x-required": "!exit 1" } });
		await runtime.refresh({ providers: ["zai"], allowNetwork: false });
		failReads = true;
		await expect(runtime.getAuth("zai")).rejects.toThrow('provider "zai" header "x-required"');
		expect(runtime.getError()).toContain("availability credential read failed");
	});

	it("retries failed availability synchronization when the command still returns empty", async () => {
		const credentials = AuthStorage.inMemory();
		const read = credentials.read.bind(credentials);
		let failRead = false;
		let reads = 0;
		vi.spyOn(credentials, "read").mockImplementation(async (providerId, options) => {
			if (failRead && providerId === "zai" && ++reads === 2) {
				throw new Error("availability credential read failed");
			}
			return read(providerId, options);
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		runtime.registerProvider("zai", { apiKey: "!printf ''" });
		await runtime.refresh({ providers: ["zai"], allowNetwork: false });
		failRead = true;
		await expect(runtime.getAuth("zai")).rejects.toThrow("availability credential read failed");
		expect(runtime.getError()).toContain("availability credential read failed");
		await expect(runtime.getAuth("zai")).resolves.toBeUndefined();
		expect(await runtime.checkAuth("zai")).toBeUndefined();
		expect(runtime.hasConfiguredAuth("zai")).toBe(false);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "zai")).toBe(false);
		expect(runtime.getError()).toBeUndefined();
	});

	it("synchronizes an empty observation when header resolution cancels the lookup", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerProvider("zai", { apiKey: "!printf ''", headers: { "x-required": "$ABORT_HEADER" } });
		await runtime.refresh({ providers: ["zai"], allowNetwork: false });
		expect(runtime.hasConfiguredAuth("zai")).toBe(true);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "zai")).toBe(true);
		const controller = new AbortController();
		const reason = new Error("cancelled after key observation");
		await expect(
			runtime.getAuth("zai", {
				signal: controller.signal,
				env: {
					get ABORT_HEADER() {
						controller.abort(reason);
						return "header-value";
					},
				},
			}),
		).rejects.toBe(reason);
		expect(controller.signal.aborted).toBe(true);
		expect(runtime.hasConfiguredAuth("zai")).toBe(false);
		expect(runtime.getProviderAuthStatus("zai")).toEqual({ configured: false });
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "zai")).toBe(false);
	});

	it("preserves caller cancellation during availability synchronization", async () => {
		const credentials = AuthStorage.inMemory();
		const read = credentials.read.bind(credentials);
		const availabilityRead = deferred();
		const availabilityStarted = deferred();
		let blockReads = false;
		let reads = 0;
		vi.spyOn(credentials, "read").mockImplementation(async (providerId, options) => {
			if (blockReads && providerId === "zai" && ++reads === 2) {
				availabilityStarted.resolve();
				await availabilityRead.promise;
			}
			return read(providerId, options);
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		runtime.registerProvider("zai", { apiKey: "!printf test-key" });
		await runtime.refresh({ providers: ["zai"], allowNetwork: false });
		const controller = new AbortController();
		blockReads = true;
		const lookup = runtime.getAuth("zai", { signal: controller.signal });
		try {
			await availabilityStarted.promise;
			controller.abort();
			availabilityRead.resolve();
			await expect(lookup).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			availabilityRead.resolve();
		}
		expect(runtime.hasConfiguredAuth("zai")).toBe(true);
		expect(runtime.getProviderAuthStatus("zai").configured).toBe(true);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "zai")).toBe(true);
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

	it("lets stored and runtime credentials override observed empty command output", async () => {
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
