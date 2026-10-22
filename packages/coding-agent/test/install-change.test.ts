import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { InstallChange } from "../src/config.ts";

const configUrl = new URL("../src/config.ts", import.meta.url).href;
const tempDirs: string[] = [];

interface ProbeResult {
	version: string;
	change: InstallChange | null;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Import config in a fresh process so each fixture captures its own startup versions and paths. */
function probeInstallChange(sourceVersion?: string, mutation = "", linked = false): ProbeResult {
	const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-install-change-")));
	tempDirs.push(tempDir);
	const root = join(tempDir, "checkout");
	const packageDir = join(root, "packages", "coding-agent");
	const packageJsonPath = join(packageDir, "package.json");
	const sourceVersionPath = join(root, ".fork", "local-version");
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(packageJsonPath, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.3.0" }));
	if (sourceVersion !== undefined) {
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, ".fork"));
		writeFileSync(sourceVersionPath, `${sourceVersion}\n`);
	}

	let launchPackageDir = packageDir;
	if (linked) {
		const scopeDir = join(tempDir, "global", "node_modules", "@earendil-works");
		mkdirSync(scopeDir, { recursive: true });
		launchPackageDir = join(scopeDir, "pi-coding-agent");
		symlinkSync(packageDir, launchPackageDir, "junction");
	}

	const probePath = join(tempDir, "probe.mjs");
	writeFileSync(
		probePath,
		[
			'import { mkdirSync, rmSync, writeFileSync } from "node:fs";',
			`import { VERSION, detectInstallChange } from ${JSON.stringify(configUrl)};`,
			`const packageJsonPath = ${JSON.stringify(packageJsonPath)};`,
			`const sourceVersionPath = ${JSON.stringify(sourceVersionPath)};`,
			mutation,
			"console.log(JSON.stringify({ version: VERSION, change: detectInstallChange() ?? null }));",
		].join("\n"),
	);
	const output = execFileSync(process.execPath, [probePath], {
		cwd: tempDir,
		env: { ...process.env, PI_PACKAGE_DIR: launchPackageDir },
		encoding: "utf-8",
		timeout: 10000,
	});
	return JSON.parse(output) as ProbeResult;
}

describe("install change detection from startup metadata", () => {
	test("does not report an unchanged package installation", () => {
		expect(probeInstallChange()).toEqual({ version: "1.3.0", change: null });
	});

	// Fork package.json versions intentionally omit the +local.N display-version suffix.
	test("does not mistake fork build metadata for an update", () => {
		expect(probeInstallChange("1.3.0+local.4")).toEqual({ version: "1.3.0+local.4", change: null });
	});

	test.each(["1.3.0+local.5", "1.3.0+local.3"])("reports a changed fork version: %s", (version) => {
		const result = probeInstallChange(
			"1.3.0+local.4",
			`writeFileSync(sourceVersionPath, ${JSON.stringify(`${version}\n`)});`,
		);
		expect(result.change).toEqual({ kind: "updated", version });
	});

	test("reports the full fork version when the upstream and fork versions both change", () => {
		const result = probeInstallChange(
			"1.3.0+local.4",
			'writeFileSync(packageJsonPath, JSON.stringify({ version: "1.3.1" }));\nwriteFileSync(sourceVersionPath, "1.3.1+local.1\\n");',
		);
		expect(result.change).toEqual({ kind: "updated", version: "1.3.1+local.1" });
	});

	test.each([undefined, "1.3.0+local.4"])("reports package version changes with source version %s", (version) => {
		const result = probeInstallChange(
			version,
			'writeFileSync(packageJsonPath, JSON.stringify({ version: "1.3.1" }));',
		);
		expect(result.change).toEqual({ kind: "updated", version: "1.3.1" });
	});

	test("reports a removed package installation", () => {
		expect(probeInstallChange("1.3.0+local.4", "rmSync(packageJsonPath);").change).toEqual({ kind: "removed" });
	});

	test("reports a removed fork version marker", () => {
		expect(probeInstallChange("1.3.0+local.4", "rmSync(sourceVersionPath);").change).toEqual({ kind: "removed" });
	});

	test("keeps checking the startup paths after the package-directory override changes", () => {
		const result = probeInstallChange("1.3.0+local.4", 'process.env.PI_PACKAGE_DIR = "/missing/pi";');
		expect(result.change).toBeNull();
	});

	test("detects fork updates through a linked global package directory", () => {
		const result = probeInstallChange("1.3.0+local.4", 'writeFileSync(sourceVersionPath, "1.3.0+local.5\\n");', true);
		expect(result.change).toEqual({ kind: "updated", version: "1.3.0+local.5" });
	});

	test("ignores whitespace-only changes to the fork version marker", () => {
		const result = probeInstallChange("1.3.0+local.4", 'writeFileSync(sourceVersionPath, " 1.3.0+local.4\\n\\n");');
		expect(result.change).toBeNull();
	});

	test("does not infer an update from an empty fork version marker", () => {
		expect(probeInstallChange("1.3.0+local.4", 'writeFileSync(sourceVersionPath, "");').change).toBeNull();
	});

	test("does not infer an update when the fork version marker cannot be read", () => {
		const result = probeInstallChange("1.3.0+local.4", "rmSync(sourceVersionPath); mkdirSync(sourceVersionPath);");
		expect(result.change).toBeNull();
	});

	test("still detects package updates when the fork version marker cannot be read", () => {
		const result = probeInstallChange(
			"1.3.0+local.4",
			'rmSync(sourceVersionPath); mkdirSync(sourceVersionPath);\nwriteFileSync(packageJsonPath, JSON.stringify({ version: "1.3.1" }));',
		);
		expect(result.change).toEqual({ kind: "updated", version: "1.3.1" });
	});

	test("does not infer an update from malformed package metadata", () => {
		expect(probeInstallChange("1.3.0+local.4", 'writeFileSync(packageJsonPath, "{");').change).toBeNull();
	});

	test.each(["{}", "null", '{"version":""}', '{"version":123}'])(
		"does not infer an update from invalid package metadata: %s",
		(contents) => {
			const result = probeInstallChange(
				"1.3.0+local.4",
				`writeFileSync(packageJsonPath, ${JSON.stringify(contents)});`,
			);
			expect(result.change).toBeNull();
		},
	);

	test("falls back to the package version when the startup fork version marker is empty", () => {
		expect(probeInstallChange("")).toEqual({ version: "1.3.0", change: null });
	});
});
