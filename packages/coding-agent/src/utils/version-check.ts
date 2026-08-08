import { compare, valid } from "semver";
import { detectInstallMethod } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const UPSTREAM_VERSION_URL = "https://pi.dev/api/latest-version";
const FORK_RELEASES_URL = "https://api.github.com/repos/DysektAI/pi-fork/releases/latest";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
	url?: string;
}

interface LocalSourceVersion {
	base: string;
	iteration: number;
}

function stripLeadingV(version: string): string {
	return version.startsWith("v") ? version.slice(1) : version;
}

function parseLocalSourceVersion(version: string): LocalSourceVersion | undefined {
	const match = /^(v?\d+\.\d+\.\d+)(?:\+local\.|\.local\.)(0|[1-9]\d*)$/.exec(version.trim());
	if (!match) return undefined;
	const base = valid(stripLeadingV(match[1]));
	return base ? { base, iteration: Number(match[2]) } : undefined;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const leftLocal = parseLocalSourceVersion(leftVersion);
	const rightLocal = parseLocalSourceVersion(rightVersion);
	if (leftLocal || rightLocal) {
		const leftBase = leftLocal?.base ?? valid(stripLeadingV(leftVersion.trim()));
		const rightBase = rightLocal?.base ?? valid(stripLeadingV(rightVersion.trim()));
		if (!leftBase || !rightBase) return undefined;
		const baseComparison = compare(leftBase, rightBase);
		if (baseComparison !== 0) return baseComparison;
		return (leftLocal?.iteration ?? 0) - (rightLocal?.iteration ?? 0);
	}

	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) return undefined;
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	return comparison !== undefined && comparison > 0;
}

async function fetchLatestFromGitHub(
	url: string,
	currentVersion: string,
	options: { timeoutMs: number; retry: boolean },
): Promise<LatestPiRelease | undefined> {
	const response = await fetchWithRetry(
		url,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
		{ maxRetries: options.retry ? 2 : 0, timeoutMs: options.timeoutMs },
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		tag_name?: unknown;
		body?: unknown;
		html_url?: unknown;
	};
	if (typeof data.tag_name !== "string" || !data.tag_name.trim()) return undefined;
	const note = typeof data.body === "string" && data.body.trim() ? data.body.trim() : undefined;
	const releaseUrl = typeof data.html_url === "string" && data.html_url.trim() ? data.html_url.trim() : undefined;
	return {
		version: stripLeadingV(data.tag_name.trim()),
		...(note ? { note } : {}),
		...(releaseUrl ? { url: releaseUrl } : {}),
	};
}

async function fetchLatestFromUpstream(
	currentVersion: string,
	options: { timeoutMs: number; retry: boolean },
): Promise<LatestPiRelease | undefined> {
	const response = await fetchWithRetry(
		UPSTREAM_VERSION_URL,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{ maxRetries: options.retry ? 2 : 0, timeoutMs: options.timeoutMs },
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) return undefined;
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		...(packageName ? { packageName } : {}),
		...(note ? { note } : {}),
	};
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;
	const requestOptions = {
		timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		retry: options.retry ?? false,
	};

	if (process.env.PI_UPDATE_API_URL) {
		return fetchLatestFromGitHub(process.env.PI_UPDATE_API_URL, currentVersion, requestOptions);
	}

	if (detectInstallMethod() === "source") {
		return fetchLatestFromGitHub(FORK_RELEASES_URL, currentVersion, requestOptions);
	}

	return fetchLatestFromUpstream(currentVersion, requestOptions);
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;
	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		return latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion) ? latestRelease : undefined;
	} catch {
		return undefined;
	}
}
