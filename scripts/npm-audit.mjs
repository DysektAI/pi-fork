// Runs `npm audit --omit=dev` and fails on advisories at or above the audit
// level, except for advisories that were reviewed and accepted below. Every
// accepted advisory must name the affected package and explain why it does not
// apply. Remove an entry once a fixed version is installed; the script warns
// about entries that no longer match.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

// Invoke npm's JavaScript entry with this Node runtime. Windows npm.cmd is not an executable,
// and a shell would interpret paths/arguments instead of preserving them.
let npmCli = process.env.npm_execpath;
if (!npmCli || basename(npmCli) !== "npm-cli.js" || !existsSync(npmCli)) {
	npmCli = undefined;
	for (const directory of [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)]) {
		if (!directory) continue;
		const installedCli = join(directory, "node_modules/npm/bin/npm-cli.js");
		if (existsSync(installedCli)) {
			npmCli = installedCli;
			break;
		}
		const executable = join(directory, "npm");
		if (existsSync(executable)) {
			try {
				const target = realpathSync(executable);
				if (basename(target) === "npm-cli.js") {
					npmCli = target;
					break;
				}
			} catch {
				// An unreadable or disappearing candidate must not hide a later usable npm installation.
			}
		}
	}
}
if (!npmCli) throw new Error("Cannot locate npm-cli.js. Install npm for the active Node runtime.");

const auditLevel = "moderate";
const severities = ["info", "low", "moderate", "high", "critical"];

/** @type {Record<string, { package: string; reason: string }>} */
const acceptedAdvisories = {
	"GHSA-86w9-cpqp-85rv": {
		package: "node-forge",
		reason:
			"No fixed node-forge release exists. It is only reachable through @earendil-works/gondolin in the private, " +
			"unpublished gondolin example extension. Gondolin only verifies leaf certificates against its own locally " +
			"generated CA (public exponent 65537), so the low-exponent signature forgery does not apply.",
	},
};

const result = spawnSync(process.execPath, [npmCli, "audit", "--omit=dev", "--json"], {
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024,
});
if (result.error) {
	throw result.error;
}
if (result.status !== 0 && result.status !== 1) {
	process.stderr.write(result.stderr ?? "");
	console.error(`npm audit failed with ${result.signal ?? `exit code ${result.status}`}.`);
	process.exit(1);
}

let report;
try {
	report = JSON.parse(result.stdout);
} catch {
	process.stderr.write(result.stderr);
	process.stderr.write(result.stdout);
	console.error("npm audit did not produce a JSON report.");
	process.exit(1);
}

if (report?.error) {
	console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
	process.exit(1);
}
if (
	!report ||
	typeof report.vulnerabilities !== "object" ||
	report.vulnerabilities === null ||
	Array.isArray(report.vulnerabilities) ||
	!Number.isSafeInteger(report.metadata?.vulnerabilities?.total) ||
	report.metadata.vulnerabilities.total !== Object.keys(report.vulnerabilities).length ||
	(result.status === 1 && report.metadata.vulnerabilities.total === 0)
) {
	console.error("npm audit did not produce a complete vulnerability report.");
	process.exit(1);
}

const minimumSeverity = severities.indexOf(auditLevel);
const seenAccepted = new Set();
const failures = new Map();
let concreteAdvisories = 0;

for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
	for (const via of vulnerability.via) {
		// String entries point at another vulnerable package, which is reported on its own.
		if (typeof via === "string") {
			continue;
		}
		let id;
		if (typeof via?.url === "string" && URL.canParse(via.url)) {
			const url = new URL(via.url);
			if (url.protocol === "https:" || url.protocol === "http:") id = url.pathname.split("/").pop() || undefined;
		}
		if (!id && Number.isSafeInteger(via?.source) && via.source > 0) id = String(via.source);
		if (
			via === null ||
			typeof via !== "object" ||
			!severities.includes(via.severity) ||
			typeof via.name !== "string" ||
			via.name.trim().length === 0 ||
			!id
		) {
			console.error("npm audit returned an invalid advisory.");
			process.exit(1);
		}
		concreteAdvisories++;
		const accepted = acceptedAdvisories[id];
		if (accepted && accepted.package === via.name) {
			seenAccepted.add(id);
			continue;
		}
		if (severities.indexOf(via.severity) >= minimumSeverity) {
			failures.set(`${id}:${via.name}`, via);
		}
	}
}

if (report.metadata.vulnerabilities.total > 0 && concreteAdvisories === 0) {
	console.error("npm audit reported vulnerable packages without concrete advisories.");
	process.exit(1);
}

for (const id of seenAccepted) {
	console.log(`Accepted ${id} (${acceptedAdvisories[id].package}): ${acceptedAdvisories[id].reason}`);
}

for (const id of Object.keys(acceptedAdvisories)) {
	if (!seenAccepted.has(id)) {
		console.log(`::warning::Accepted advisory ${id} no longer matches; remove it from scripts/npm-audit.mjs.`);
	}
}

if (failures.size > 0) {
	console.error(`\nFound ${failures.size} unaccepted advisories at or above ${auditLevel}:`);
	for (const via of failures.values()) {
		console.error(`- ${via.name} ${via.range} [${via.severity}] ${via.title} ${via.url}`);
	}
	process.exit(1);
}

console.log(`No unaccepted advisories at or above ${auditLevel}.`);
