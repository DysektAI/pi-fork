import { describe, expect, it } from "vitest";
import { parseJsonWithRepair, parseStreamingJson, repairJson } from "../src/utils/json-parse.ts";

describe("repairJson", () => {
	it("passes through valid JSON unchanged", () => {
		const valid = '{"key": "value", "num": 42}';
		expect(repairJson(valid)).toBe(valid);
	});

	it("escapes raw control characters inside strings", () => {
		const input = '{"text": "line1\nline2"}';
		const repaired = repairJson(input);
		expect(repaired).toBe('{"text": "line1\\nline2"}');
	});

	it("escapes raw tab characters inside strings", () => {
		const input = '{"text": "col1\tcol2"}';
		const repaired = repairJson(input);
		expect(repaired).toBe('{"text": "col1\\tcol2"}');
	});

	it("doubles backslash before invalid escape sequences", () => {
		const input = '{"path": "C:\\Users\\test"}';
		const repaired = repairJson(input);
		expect(() => JSON.parse(repaired)).not.toThrow();
	});

	it("preserves valid escape sequences", () => {
		const input = '{"text": "hello\\nworld\\t!"}';
		expect(repairJson(input)).toBe(input);
	});

	it("preserves valid unicode escapes", () => {
		const input = '{"emoji": "\\u0041"}';
		expect(repairJson(input)).toBe(input);
	});

	it("handles trailing backslash", () => {
		const input = '{"val": "test\\';
		const repaired = repairJson(input);
		expect(repaired).toContain("\\\\");
	});

	it("handles incomplete unicode escape gracefully", () => {
		// \u followed by non-hex chars: when the 4-char hex check fails,
		// \u is still in VALID_JSON_ESCAPES so it passes through as \u
		const input = '{"val": "\\u00G"}';
		const repaired = repairJson(input);
		expect(repaired).toContain("\\u");
	});
});

describe("parseJsonWithRepair", () => {
	it("parses valid JSON directly", () => {
		const result = parseJsonWithRepair<{ x: number }>('{"x": 1}');
		expect(result).toEqual({ x: 1 });
	});

	it("repairs and parses malformed JSON with invalid escape", () => {
		// \q is not a valid JSON escape, so repairJson doubles the backslash
		const input = '{"msg": "hello\\qworld"}';
		const result = parseJsonWithRepair<{ msg: string }>(input);
		expect(result.msg).toBe("hello\\qworld");
	});

	it("throws on unfixable JSON", () => {
		expect(() => parseJsonWithRepair("not json at all")).toThrow();
	});
});

describe("parseStreamingJson", () => {
	it("returns empty object for undefined input", () => {
		expect(parseStreamingJson(undefined)).toEqual({});
	});

	it("returns empty object for empty string", () => {
		expect(parseStreamingJson("")).toEqual({});
	});

	it("returns empty object for whitespace-only input", () => {
		expect(parseStreamingJson("   ")).toEqual({});
	});

	it("parses complete JSON", () => {
		const result = parseStreamingJson<{ name: string }>('{"name": "test"}');
		expect(result).toEqual({ name: "test" });
	});

	it("parses partial JSON gracefully", () => {
		const result = parseStreamingJson<{ name: string }>('{"name": "te');
		expect(result).toHaveProperty("name");
	});

	it("returns empty object for totally invalid input", () => {
		const result = parseStreamingJson("{{{{invalid");
		expect(result).toEqual({});
	});
});
