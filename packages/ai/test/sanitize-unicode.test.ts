import { describe, expect, it } from "vitest";
import { sanitizeSurrogates } from "../src/utils/sanitize-unicode.ts";

describe("sanitizeSurrogates", () => {
	it("passes through normal text unchanged", () => {
		expect(sanitizeSurrogates("hello world")).toBe("hello world");
	});

	it("preserves valid emoji (properly paired surrogates)", () => {
		expect(sanitizeSurrogates("Hello 🙈 World")).toBe("Hello 🙈 World");
	});

	it("preserves multiple emoji", () => {
		const input = "🎉🎊🎈";
		expect(sanitizeSurrogates(input)).toBe(input);
	});

	it("removes unpaired high surrogate", () => {
		const unpaired = String.fromCharCode(0xd83d);
		const input = `Text ${unpaired} here`;
		expect(sanitizeSurrogates(input)).toBe("Text  here");
	});

	it("removes unpaired low surrogate", () => {
		const unpaired = String.fromCharCode(0xde00);
		const input = `Start ${unpaired} end`;
		expect(sanitizeSurrogates(input)).toBe("Start  end");
	});

	it("handles empty string", () => {
		expect(sanitizeSurrogates("")).toBe("");
	});

	it("preserves characters outside BMP that use proper surrogate pairs", () => {
		const math = "\u{1D400}";
		expect(sanitizeSurrogates(math)).toBe(math);
	});

	it("removes multiple unpaired surrogates", () => {
		const high = String.fromCharCode(0xd800);
		const low = String.fromCharCode(0xdc00);
		const input = `${high}a${low}b`;
		expect(sanitizeSurrogates(input)).toBe("ab");
	});
});
