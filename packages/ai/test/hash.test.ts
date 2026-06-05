import { describe, expect, it } from "vitest";
import { shortHash } from "../src/utils/hash.ts";

describe("shortHash", () => {
	it("returns a non-empty string", () => {
		expect(shortHash("hello")).toBeTruthy();
		expect(typeof shortHash("hello")).toBe("string");
	});

	it("is deterministic", () => {
		const a = shortHash("test-input");
		const b = shortHash("test-input");
		expect(a).toBe(b);
	});

	it("produces different hashes for different inputs", () => {
		const a = shortHash("foo");
		const b = shortHash("bar");
		const c = shortHash("baz");
		expect(a).not.toBe(b);
		expect(b).not.toBe(c);
		expect(a).not.toBe(c);
	});

	it("handles empty string", () => {
		const result = shortHash("");
		expect(result).toBeTruthy();
		expect(typeof result).toBe("string");
	});

	it("handles long strings", () => {
		const long = "a".repeat(10000);
		const result = shortHash(long);
		expect(result).toBeTruthy();
		expect(result.length).toBeGreaterThan(0);
		expect(result.length).toBeLessThan(20);
	});

	it("produces compact base-36 output", () => {
		const result = shortHash("some input");
		expect(result).toMatch(/^[0-9a-z]+$/);
	});
});
