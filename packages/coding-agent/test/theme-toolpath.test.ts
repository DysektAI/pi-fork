import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

const REQUIRED_COLOR_TOKENS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"selectedBg",
	"userMessageBg",
	"userMessageText",
	"customMessageBg",
	"customMessageText",
	"customMessageLabel",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
];

function baseColors(overrides: Record<string, string | number> = {}): Record<string, string | number> {
	const colors: Record<string, string | number> = {};
	for (const token of REQUIRED_COLOR_TOKENS) {
		colors[token] = "#111111";
	}
	colors.accent = "#aabbcc";
	return { ...colors, ...overrides };
}

const trueColorAnsi = (hex: string): string => {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
};

describe("toolPath theme token", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-toolpath-"));
		mkdirSync(tempRoot, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	const writeTheme = (theme: ThemeFile): string => {
		const themePath = join(tempRoot, `${theme.name}.json`);
		writeFileSync(themePath, JSON.stringify(theme, null, 2));
		return themePath;
	};

	it("uses the explicit toolPath color when provided", () => {
		const themePath = writeTheme({
			name: "with-toolpath",
			colors: baseColors({ toolPath: "#6ca0d6" }),
		});

		const theme = loadThemeFromPath(themePath, "truecolor");

		expect(theme.getFgAnsi("toolPath")).toBe(trueColorAnsi("#6ca0d6"));
		expect(theme.getFgAnsi("toolPath")).not.toBe(theme.getFgAnsi("accent"));
	});

	it("falls back to accent when toolPath is omitted", () => {
		const themePath = writeTheme({
			name: "without-toolpath",
			colors: baseColors(),
		});

		const theme = loadThemeFromPath(themePath, "truecolor");

		expect(theme.getFgAnsi("toolPath")).toBe(theme.getFgAnsi("accent"));
		expect(theme.getFgAnsi("toolPath")).toBe(trueColorAnsi("#aabbcc"));
	});

	it("resolves toolPath through var references", () => {
		const themePath = writeTheme({
			name: "toolpath-var",
			vars: { link: "#6ca0d6" },
			colors: baseColors({ toolPath: "link" }),
		});

		const theme = loadThemeFromPath(themePath, "truecolor");

		expect(theme.getFgAnsi("toolPath")).toBe(trueColorAnsi("#6ca0d6"));
	});

	it("does not throw when reading toolPath on a theme that omits it", () => {
		const themePath = writeTheme({
			name: "no-toolpath-no-throw",
			colors: baseColors(),
		});

		const theme = loadThemeFromPath(themePath, "truecolor");

		expect(() => theme.fg("toolPath", "x")).not.toThrow();
	});
});
