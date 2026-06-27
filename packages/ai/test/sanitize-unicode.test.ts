import { afterEach, describe, expect, it } from "vitest";
import { sanitizeSurrogates, stripGhostTokens } from "../src/utils/sanitize-unicode.ts";

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

	it("strips zero-width ghost characters", () => {
		expect(sanitizeSurrogates("he\u200bllo\uFEFF world")).toBe("hello world");
	});
});

describe("stripGhostTokens", () => {
	afterEach(() => {
		delete process.env.PI_KEEP_GHOST_TOKENS;
	});

	it("removes zero-width space, word joiner, BOM and soft hyphen", () => {
		const input = "a\u200bb\u2060c\uFEFFd\u00ade";
		expect(stripGhostTokens(input)).toBe("abcde");
	});

	it("removes invisible TAG-block characters", () => {
		const input = `hi${String.fromCodePoint(0xe0041)}${String.fromCodePoint(0xe007f)}`;
		expect(stripGhostTokens(input)).toBe("hi");
	});

	it("preserves meaningful joiners, bidi marks and emoji variation selectors", () => {
		// ZWJ emoji family, ZWNJ, RLM, and VS16 must survive
		const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
		const input = `${family} \u200c \u200f \u2764\uFE0F`;
		expect(stripGhostTokens(input)).toBe(input);
	});

	it("leaves normal whitespace untouched", () => {
		const input = "line1\n  line2\tend\r\n";
		expect(stripGhostTokens(input)).toBe(input);
	});

	it("opts out via PI_KEEP_GHOST_TOKENS=1", () => {
		process.env.PI_KEEP_GHOST_TOKENS = "1";
		const input = "a\u200bb";
		expect(stripGhostTokens(input)).toBe(input);
	});
});
