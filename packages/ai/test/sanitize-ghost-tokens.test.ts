import { afterEach, describe, expect, it } from "vitest";
import { sanitizeSurrogates, stripGhostTokens } from "../src/utils/sanitize-unicode.ts";

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

describe("sanitizeSurrogates ghost-token integration", () => {
	it("strips zero-width ghost characters as part of sanitization", () => {
		expect(sanitizeSurrogates("he\u200bllo\uFEFF world")).toBe("hello world");
	});

	it("still preserves valid emoji while stripping ghosts", () => {
		expect(sanitizeSurrogates("Hello\u200b 🙈 World")).toBe("Hello 🙈 World");
	});
});
