import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkPath, renderToolPath } from "../src/core/tools/render-utils.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const OSC8_PREFIX = "\x1b]8;;";

describe("render-utils path linkification", () => {
	let tempRoot: string;
	let savedTermProgram: string | undefined;

	beforeEach(() => {
		savedTermProgram = process.env.TERM_PROGRAM;
		delete process.env.TERM_PROGRAM;
		tempRoot = mkdtempSync(join(tmpdir(), "pi-render-utils-"));
		mkdirSync(tempRoot, { recursive: true });
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	});

	afterEach(() => {
		resetCapabilitiesCache();
		initTheme("dark");
		rmSync(tempRoot, { recursive: true, force: true });
		if (savedTermProgram === undefined) {
			delete process.env.TERM_PROGRAM;
		} else {
			process.env.TERM_PROGRAM = savedTermProgram;
		}
	});

	const writeFile = (name: string): string => {
		const filePath = join(tempRoot, name);
		writeFileSync(filePath, "x");
		return filePath;
	};

	it("wraps the path in an OSC 8 file:// hyperlink in non-VS Code terminals", () => {
		const filePath = writeFile("a.txt");
		const out = linkPath("styled", filePath, tempRoot);

		expect(out).toContain(OSC8_PREFIX);
		expect(out).toContain(pathToFileURL(filePath).href);
	});

	it("omits the OSC 8 hyperlink in the VS Code integrated terminal", () => {
		process.env.TERM_PROGRAM = "vscode";
		const filePath = writeFile("b.txt");
		const out = linkPath("styled", filePath, tempRoot);

		expect(out).toBe("styled");
		expect(out).not.toContain(OSC8_PREFIX);
		expect(out).not.toContain("file://");
	});

	it("renderToolPath shows the absolute path (not ~) as plain text in VS Code", () => {
		process.env.TERM_PROGRAM = "vscode";
		const filePath = writeFile("c.txt");
		const out = renderToolPath(filePath, theme, tempRoot);

		expect(out).toContain(filePath);
		expect(out).not.toContain(OSC8_PREFIX);
		expect(out).not.toContain("file://");
	});
});
