import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalPackageDir = process.env.PI_PACKAGE_DIR;
const originalUpdateApiUrl = process.env.PI_UPDATE_API_URL;

beforeEach(() => {
	delete process.env.PI_SKIP_VERSION_CHECK;
	delete process.env.PI_UPDATE_API_URL;
	process.env.PI_PACKAGE_DIR = "/opt/pi-installed";
	allowNetwork();
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalPackageDir === undefined) {
		delete process.env.PI_PACKAGE_DIR;
	} else {
		process.env.PI_PACKAGE_DIR = originalPackageDir;
	}
	if (originalUpdateApiUrl === undefined) {
		delete process.env.PI_UPDATE_API_URL;
	} else {
		process.env.PI_UPDATE_API_URL = originalUpdateApiUrl;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
		expect(isNewerPackageVersion("0.82.0+local.9", "0.82.0+local.8")).toBe(true);
		expect(isNewerPackageVersion("0.82.0.local.9", "0.82.0.local.8")).toBe(true);
		expect(isNewerPackageVersion("0.81.1+local.99", "0.82.0+local.1")).toBe(false);
		expect(isNewerPackageVersion("not-semver", "0.82.0+local.1")).toBe(false);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("uses the pi.dev version check api with a pi user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://pi.dev/api/latest-version",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("retries a transient version request when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3", { retry: true })).resolves.toEqual({ version: "1.2.4" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps automatic version checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("returns the active package metadata from the version check api", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@new-scope/pi",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/pi",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("uses source releases and retains their GitHub URL", async () => {
		process.env.PI_PACKAGE_DIR = process.cwd();
		const fetchMock = vi.fn(async () =>
			Response.json({
				tag_name: "1.2.3+local.9",
				body: "source build",
				html_url: "https://github.com/DysektAI/pi-fork/releases/tag/1.2.3%2Blocal.9",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3+local.8")).resolves.toEqual({
			version: "1.2.3+local.9",
			note: "source build",
			url: "https://github.com/DysektAI/pi-fork/releases/tag/1.2.3%2Blocal.9",
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("does not fall back to upstream when the fork release request fails", async () => {
		process.env.PI_PACKAGE_DIR = process.cwd();
		const fetchMock = vi.fn().mockRejectedValueOnce(new Error("GitHub unavailable"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3+local.8")).rejects.toThrow("GitHub unavailable");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/DysektAI/pi-fork/releases/latest");
	});

	it("uses an explicit fork release endpoint override", async () => {
		process.env.PI_UPDATE_API_URL = "https://example.test/releases/latest";
		const fetchMock = vi.fn(async () =>
			Response.json({
				tag_name: "1.2.3+local.9",
				html_url: "https://example.test/releases/1.2.3+local.9",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3+local.8")).resolves.toEqual({
			version: "1.2.3+local.9",
			url: "https://example.test/releases/1.2.3+local.9",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://example.test/releases/latest",
			expect.objectContaining({ headers: expect.any(Object) }),
		);
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
