import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { execNpmSync } from "./npm-command.mjs";

const manifestSchemaVersion = 1;

export function normalizePackResult(output, packageName) {
	const parsed = JSON.parse(output);
	const results = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
	const packed = results[0];
	if (
		results.length !== 1 ||
		typeof packed?.filename !== "string" ||
		!packed.filename.endsWith(".tgz") ||
		packed.filename !== packed.filename.replaceAll("\\", "/").split("/").at(-1) ||
		!Array.isArray(packed.files) ||
		!Number.isFinite(packed.size) ||
		!Number.isFinite(packed.unpackedSize)
	) {
		throw new Error(`npm pack returned an unexpected result for ${packageName}`);
	}
	return packed;
}

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function getGitSource(repoRoot) {
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
	const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
	return { commit, dirty: status.length > 0 };
}

function packPackages(packages, tarballDirectory) {
	mkdirSync(tarballDirectory, { recursive: true });
	const packedPackages = [];
	for (const pkg of packages) {
		const packageJson = JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"));
		if (packageJson.name !== pkg.name) throw new Error(`Unexpected package name in ${pkg.directory}`);
		const output = execNpmSync(["pack", "--ignore-scripts", "--json", "--pack-destination", tarballDirectory], {
			cwd: pkg.directory,
			encoding: "utf8",
			stdio: ["inherit", "pipe", "inherit"],
		});
		const packed = normalizePackResult(output, pkg.name);

		const originalPath = join(tarballDirectory, packed.filename);
		const contents = readFileSync(originalPath);
		const digest = createHash("sha512").update(contents).digest();
		const hash = digest.toString("hex").slice(0, 12);
		const tarballPath = originalPath.replace(/\.tgz$/, `-${hash}.tgz`);
		renameSync(originalPath, tarballPath);
		console.log(
			`  ${pkg.name}@${pkg.version}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`,
		);
		packedPackages.push({
			name: pkg.name,
			version: pkg.version,
			tarballPath,
			integrity: `sha512-${digest.toString("base64")}`,
		});
	}
	return packedPackages;
}

function prepareOutputDirectory(outDir, options) {
	const repoRoot = resolve(options.repoRoot);
	if (!outDir) return mkdtempSync(join(tmpdir(), "pi-package-artifacts-"));
	const outputDirectory = resolve(outDir);
	if (dirname(outputDirectory) === outputDirectory || isInsidePath(repoRoot, outputDirectory)) {
		throw new Error(`Output directory must not be the repository, its ancestor, or a filesystem root: ${outputDirectory}`);
	}
	if (isInsidePath(outputDirectory, repoRoot) && !isInsidePath(outputDirectory, join(repoRoot, ".artifacts"))) {
		throw new Error(`Repository-local output directory must be inside ${join(repoRoot, ".artifacts")}: ${outputDirectory}`);
	}
	// Resolve existing ancestors before creating or replacing anything. Repository and
	// system temporary-directory ancestors are trusted, but output components are not.
	let ancestor = outputDirectory;
	const missingComponents = [];
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) throw new Error(`Cannot resolve output directory ancestor: ${outputDirectory}`);
		missingComponents.unshift(relative(parent, ancestor));
		ancestor = parent;
	}
	const canonicalOutput = resolve(realpathSync(ancestor), ...missingComponents);
	const canonicalRoot = realpathSync(repoRoot);
	if (dirname(canonicalOutput) === canonicalOutput || isInsidePath(canonicalRoot, canonicalOutput)) {
		throw new Error(`Output directory must not be the repository, its ancestor, or a filesystem root: ${outputDirectory}`);
	}
	if (isInsidePath(canonicalOutput, canonicalRoot) && !isInsidePath(canonicalOutput, join(canonicalRoot, ".artifacts"))) {
		throw new Error(`Output directory must not traverse a symbolic link into repository contents: ${outputDirectory}`);
	}
	for (let component = outputDirectory; component !== repoRoot && component !== resolve(tmpdir()); component = dirname(component)) {
		try {
			if (lstatSync(component).isSymbolicLink()) {
				throw new Error(`Output directory must not traverse a symbolic link: ${outputDirectory}`);
			}
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (dirname(component) === component) break;
	}
	if (existsSync(outputDirectory)) {
		if (!options.force) throw new Error(`Output directory already exists. Use --force to replace it: ${outputDirectory}`);
		rmSync(outputDirectory, { force: true, recursive: true });
	}
	mkdirSync(outputDirectory, { recursive: true });
	return outputDirectory;
}

export function produceArtifactSet({ repoRoot, outDir, build = true, offlineModelData = false, force = false, source }) {
	const root = resolve(repoRoot);
	const artifactDirectory = prepareOutputDirectory(outDir, { force, repoRoot: root });
	try {
		if (build) {
			execNpmSync(["run", "clean"], { cwd: root, stdio: "inherit" });
			execNpmSync(["run", offlineModelData ? "build:offline" : "build"], { cwd: root, stdio: "inherit" });
		}
		const artifactSource = source === undefined ? getGitSource(root) : source;
		const packages = getPublicWorkspacePackages(join(root, "packages"));
		const packedPackages = packPackages(packages, join(artifactDirectory, "tarballs"));
		const manifest = {
			schemaVersion: manifestSchemaVersion,
			source: artifactSource,
			packages: packedPackages
				.map(({ name, version, tarballPath, integrity }) => ({
					name,
					version,
					tarball: relative(artifactDirectory, tarballPath).replaceAll("\\", "/"),
					integrity,
				}))
				.sort((left, right) => left.name.localeCompare(right.name)),
		};
		const manifestPath = join(artifactDirectory, "manifest.json");
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		return readArtifactSet(manifestPath);
	} catch (error) {
		if (!outDir) rmSync(artifactDirectory, { recursive: true, force: true });
		throw error;
	}
}

export function readArtifactSet(manifestPath) {
	const absoluteManifestPath = resolve(manifestPath);
	const artifactDirectory = dirname(absoluteManifestPath);
	const manifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));
	if (manifest.schemaVersion !== manifestSchemaVersion || !Array.isArray(manifest.packages)) {
		throw new Error(`Unsupported package artifact manifest: ${absoluteManifestPath}`);
	}
	const names = new Set();
	const packages = manifest.packages.map((pkg) => {
		if (
			typeof pkg?.name !== "string" ||
			typeof pkg.version !== "string" ||
			typeof pkg.tarball !== "string" ||
			typeof pkg.integrity !== "string"
		) {
			throw new Error(`Invalid package entry in artifact manifest: ${absoluteManifestPath}`);
		}
		if (names.has(pkg.name)) throw new Error(`Duplicate package in artifact manifest: ${pkg.name}`);
		names.add(pkg.name);
		const tarballPath = resolve(artifactDirectory, pkg.tarball);
		if (!isInsidePath(tarballPath, artifactDirectory) || !existsSync(tarballPath)) {
			throw new Error(`Missing package tarball for ${pkg.name}: ${tarballPath}`);
		}
		const integrity = `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`;
		if (integrity !== pkg.integrity) throw new Error(`Package tarball integrity mismatch for ${pkg.name}: ${tarballPath}`);
		return { ...pkg, tarballPath };
	});
	return {
		artifactDirectory,
		manifestPath: absoluteManifestPath,
		packages,
		source: manifest.source,
		getPackage(name) {
			const pkg = packages.find((candidate) => candidate.name === name);
			if (!pkg) throw new Error(`Package is not present in the artifact set: ${name}`);
			return pkg;
		},
	};
}
