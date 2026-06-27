import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getThemeMissingTokenWarning, loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";

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

describe("missing optional theme tokens", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-missing-"));
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

	it("records each omitted optional token with its fallback", () => {
		const themePath = writeTheme({ name: "bare", colors: baseColors() });

		const theme = loadThemeFromPath(themePath, "truecolor");
		const tokens = theme.missingOptionalTokens.map((entry) => entry.token).sort();

		expect(tokens).toEqual(["thinkingMax", "toolPath"]);
		const thinkingMax = theme.missingOptionalTokens.find((entry) => entry.token === "thinkingMax");
		expect(thinkingMax?.fallback).toBe("thinkingXhigh");
		const toolPath = theme.missingOptionalTokens.find((entry) => entry.token === "toolPath");
		expect(toolPath?.fallback).toBe("accent");
	});

	it("records only the still-missing token when some are present", () => {
		const themePath = writeTheme({
			name: "has-toolpath",
			colors: baseColors({ toolPath: "#6ca0d6" }),
		});

		const theme = loadThemeFromPath(themePath, "truecolor");

		expect(theme.missingOptionalTokens.map((entry) => entry.token)).toEqual(["thinkingMax"]);
	});

	it("records nothing when every optional token is defined", () => {
		const themePath = writeTheme({
			name: "complete",
			colors: baseColors({ toolPath: "#6ca0d6", thinkingMax: "#ff5fd7" }),
		});

		const theme = loadThemeFromPath(themePath, "truecolor");

		expect(theme.missingOptionalTokens).toEqual([]);
	});

	it("builds an actionable warning naming the theme, tokens, and source path", () => {
		const themePath = writeTheme({ name: "dysekt-matte", colors: baseColors() });

		const theme = loadThemeFromPath(themePath, "truecolor");
		const warning = getThemeMissingTokenWarning(theme);

		expect(warning).toBeDefined();
		expect(warning).toContain('"dysekt-matte"');
		expect(warning).toContain("thinkingMax");
		expect(warning).toContain("toolPath");
		expect(warning).toContain(themePath);
	});

	it("returns no warning when the theme defines every optional token", () => {
		const themePath = writeTheme({
			name: "complete",
			colors: baseColors({ toolPath: "#6ca0d6", thinkingMax: "#ff5fd7" }),
		});

		const theme = loadThemeFromPath(themePath, "truecolor");

		expect(getThemeMissingTokenWarning(theme)).toBeUndefined();
	});
});
