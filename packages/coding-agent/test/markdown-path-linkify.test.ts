import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getMarkdownTheme,
	initTheme,
	loadThemeFromPath,
	setThemeInstance,
} from "../src/modes/interactive/theme/theme.ts";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

const TOOL_PATH_HEX = "#6ca0d6";
const MD_CODE_HEX = "#d4c97e";

const trueColorAnsi = (hex: string): string => {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
};

const TOOL_PATH_ANSI = trueColorAnsi(TOOL_PATH_HEX);
const MD_CODE_ANSI = trueColorAnsi(MD_CODE_HEX);
const OSC8_PREFIX = "\x1b]8;;";

describe("markdown inline-code path linkify", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-md-linkify-"));
		mkdirSync(tempRoot, { recursive: true });

		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		const customTheme: ThemeFile = {
			...darkTheme,
			name: "linkify-test",
			colors: { ...darkTheme.colors, toolPath: TOOL_PATH_HEX, mdCode: MD_CODE_HEX },
		};
		const themePath = join(tempRoot, "linkify-test.json");
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));
		setThemeInstance(loadThemeFromPath(themePath, "truecolor"));
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	});

	afterEach(() => {
		resetCapabilitiesCache();
		initTheme("dark");
		rmSync(tempRoot, { recursive: true, force: true });
	});

	const writeFile = (name: string): string => {
		const filePath = join(tempRoot, name);
		writeFileSync(filePath, "x");
		return filePath;
	};

	it("linkifies an existing absolute path with toolPath color and an OSC 8 hyperlink", () => {
		const filePath = writeFile("exists.txt");
		const out = getMarkdownTheme(tempRoot).code(filePath);

		expect(out).toContain(TOOL_PATH_ANSI);
		expect(out).not.toContain(MD_CODE_ANSI);
		expect(out).toContain(OSC8_PREFIX);
		expect(out).toContain(pathToFileURL(filePath).href);
	});

	it("linkifies an existing relative path resolved against the session cwd", () => {
		writeFile("rel.ts");
		const out = getMarkdownTheme(tempRoot).code("rel.ts");

		expect(out).toContain(TOOL_PATH_ANSI);
		expect(out).toContain(OSC8_PREFIX);
		expect(out).toContain(pathToFileURL(join(tempRoot, "rel.ts")).href);
	});

	it("linkifies a path with a :line suffix", () => {
		const filePath = writeFile("withline.ts");
		const out = getMarkdownTheme(tempRoot).code(`${filePath}:42`);

		expect(out).toContain(TOOL_PATH_ANSI);
		expect(out).toContain(OSC8_PREFIX);
		expect(out).toContain(pathToFileURL(filePath).href);
	});

	it("does not linkify a shell command containing spaces", () => {
		const out = getMarkdownTheme(tempRoot).code("npm run dev");

		expect(out).toContain(MD_CODE_ANSI);
		expect(out).not.toContain(TOOL_PATH_ANSI);
		expect(out).not.toContain(OSC8_PREFIX);
	});

	it("does not linkify a function-call token", () => {
		const out = getMarkdownTheme(tempRoot).code("useEffect()");

		expect(out).toContain(MD_CODE_ANSI);
		expect(out).not.toContain(OSC8_PREFIX);
	});

	it("does not linkify a path-like string that does not exist", () => {
		const out = getMarkdownTheme(tempRoot).code("does/not/exist.ts");

		expect(out).toContain(MD_CODE_ANSI);
		expect(out).not.toContain(TOOL_PATH_ANSI);
		expect(out).not.toContain(OSC8_PREFIX);
	});

	it("colors existing paths with toolPath but omits OSC 8 when hyperlinks are unsupported", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const filePath = writeFile("nolink.txt");
		const out = getMarkdownTheme(tempRoot).code(filePath);

		expect(out).toContain(TOOL_PATH_ANSI);
		expect(out).not.toContain(OSC8_PREFIX);
	});
});
