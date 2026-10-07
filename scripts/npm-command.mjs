import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

export function execNpmSync(args, options = {}) {
	if (process.platform !== "win32") return execFileSync("npm", args, options);
	let npmCli = process.env.npm_execpath;
	if (!npmCli || basename(npmCli) !== "npm-cli.js" || !existsSync(npmCli)) {
		npmCli = undefined;
		for (const directory of [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)]) {
			if (!directory) continue;
			const candidate = join(directory, "node_modules/npm/bin/npm-cli.js");
			if (existsSync(candidate)) {
				npmCli = candidate;
				break;
			}
		}
	}
	if (!npmCli) throw new Error("Cannot locate npm-cli.js. Install npm for the active Node runtime.");
	return execFileSync(process.execPath, [npmCli, ...args], options);
}
