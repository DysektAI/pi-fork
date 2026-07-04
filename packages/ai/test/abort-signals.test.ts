import { describe, expect, it } from "vitest";
import { combineAbortSignals } from "../src/utils/abort-signals.ts";

describe("combineAbortSignals", () => {
	it("returns no signal when given no signals", () => {
		const result = combineAbortSignals([]);
		expect(result.signal).toBeUndefined();
		result.cleanup();
	});

	it("returns no signal when all inputs are undefined", () => {
		const result = combineAbortSignals([undefined, undefined]);
		expect(result.signal).toBeUndefined();
		result.cleanup();
	});

	it("returns the single signal directly when only one provided", () => {
		const controller = new AbortController();
		const result = combineAbortSignals([controller.signal]);
		expect(result.signal).toBe(controller.signal);
		result.cleanup();
	});

	it("returns the single signal when others are undefined", () => {
		const controller = new AbortController();
		const result = combineAbortSignals([undefined, controller.signal, undefined]);
		expect(result.signal).toBe(controller.signal);
		result.cleanup();
	});

	it("creates a combined signal from multiple signals", () => {
		const c1 = new AbortController();
		const c2 = new AbortController();
		const result = combineAbortSignals([c1.signal, c2.signal]);
		expect(result.signal).toBeDefined();
		expect(result.signal).not.toBe(c1.signal);
		expect(result.signal).not.toBe(c2.signal);
		expect(result.signal!.aborted).toBe(false);
		result.cleanup();
	});

	it("aborts combined signal when first signal aborts", () => {
		const c1 = new AbortController();
		const c2 = new AbortController();
		const result = combineAbortSignals([c1.signal, c2.signal]);

		c1.abort("reason1");
		expect(result.signal!.aborted).toBe(true);
		expect(result.signal!.reason).toBe("reason1");
		result.cleanup();
	});

	it("aborts combined signal when second signal aborts", () => {
		const c1 = new AbortController();
		const c2 = new AbortController();
		const result = combineAbortSignals([c1.signal, c2.signal]);

		c2.abort("reason2");
		expect(result.signal!.aborted).toBe(true);
		expect(result.signal!.reason).toBe("reason2");
		result.cleanup();
	});

	it("handles already-aborted signal", () => {
		const c1 = new AbortController();
		c1.abort("already");
		const c2 = new AbortController();
		const result = combineAbortSignals([c1.signal, c2.signal]);
		expect(result.signal!.aborted).toBe(true);
		expect(result.signal!.reason).toBe("already");
		result.cleanup();
	});

	it("cleanup removes event listeners", () => {
		const c1 = new AbortController();
		const c2 = new AbortController();
		const result = combineAbortSignals([c1.signal, c2.signal]);
		result.cleanup();

		c1.abort("after-cleanup");
		expect(result.signal!.aborted).toBe(false);
	});
});
