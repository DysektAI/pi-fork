/**
 * Dependency-free structural outline for source files.
 *
 * Produces a compact, line-numbered summary of a file's top-level and nested
 * declarations (functions, classes, methods, interfaces, types, etc.) with
 * bodies elided. The model reads the outline to navigate a large file, then
 * reads the specific ranges it cares about with offset/limit.
 *
 * This intentionally avoids tree-sitter / the TypeScript compiler API so the
 * coding-agent package gains no new runtime dependency and no native addon.
 * Detection is heuristic (indentation + per-language declaration patterns),
 * which is accurate enough to navigate a file without parsing it.
 */

/** A single declaration discovered in the source. */
export interface OutlineEntry {
	/** 1-indexed line number where the declaration starts. */
	line: number;
	/** Nesting depth (0 = top level), derived from leading indentation. */
	depth: number;
	/** The trimmed declaration text (signature line, body elided). */
	text: string;
}

export interface OutlineResult {
	entries: OutlineEntry[];
	/** Language family used for detection, or undefined when unsupported. */
	family?: OutlineFamily;
}

type OutlineFamily = "c-like" | "python" | "ruby" | "go" | "rust";

/** Map a highlight language id (from getLanguageFromPath) to an outline family. */
function familyForLanguage(language: string | undefined): OutlineFamily | undefined {
	switch (language) {
		case "typescript":
		case "javascript":
		case "java":
		case "kotlin":
		case "swift":
		case "c":
		case "cpp":
		case "csharp":
		case "php":
		case "scala":
			return "c-like";
		case "python":
			return "python";
		case "ruby":
			return "ruby";
		case "go":
			return "go";
		case "rust":
			return "rust";
		default:
			return undefined;
	}
}

const DECL_PATTERNS: Record<OutlineFamily, RegExp> = {
	// Functions, classes, interfaces, types, enums, exported consts/lets that
	// open a block or are assigned a function/arrow, and class methods.
	"c-like":
		/^(export\s+)?(default\s+)?(public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|final\s+|async\s+|override\s+|readonly\s+|sealed\s+|partial\s+)*(class|interface|enum|struct|namespace|module|trait|protocol|extension|function|func|fn|def|record)\b/,
	python: /^(\s*)(async\s+)?(def|class)\s+\w+/,
	ruby: /^(\s*)(def|class|module)\s+[\w:.<]/,
	go: /^(func|type)\s+/,
	rust: /^(\s*)(pub\s+)?(async\s+)?(unsafe\s+)?(fn|struct|enum|trait|impl|mod|type)\b/,
};

// Secondary patterns for c-like: arrow/function expressions assigned to a name,
// bare method declarations inside a class body (e.g. `foo(args) {`), and type
// aliases (`type Name = ...`, distinct from `type:` properties or import members).
const CLIKE_ASSIGNED =
	/^(export\s+)?(default\s+)?(public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*(const|let|var)\s+\w+\s*[:=].*(=>|\bfunction\b)/;
const CLIKE_METHOD =
	/^(public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+|\*\s*)*[\w$]+\s*\([^;]*\)\s*(:[^{;]+)?\{?\s*$/;
const CLIKE_TYPE = /^(export\s+)?(declare\s+)?type\s+\w+[^=]*=/;
const CLIKE_CONTROL = /^(if|else|for|while|switch|catch|do|try|return|case|default|break|continue)\b/;

/** Count leading whitespace columns (tabs counted as one) for depth. */
function indentWidth(line: string): number {
	let width = 0;
	for (const ch of line) {
		if (ch === " " || ch === "\t") width++;
		else break;
	}
	return width;
}

function isCommentOrBlank(trimmed: string): boolean {
	if (trimmed === "") return true;
	return (
		trimmed.startsWith("//") ||
		trimmed.startsWith("#") ||
		trimmed.startsWith("*") ||
		trimmed.startsWith("/*") ||
		trimmed.startsWith("--")
	);
}

/**
 * Extract a structural outline from source text.
 *
 * @param content full file text (LF-normalized is fine; raw is fine too)
 * @param language highlight language id from getLanguageFromPath
 * @param startLine 1-indexed line number of the first line of `content`
 */
export function extractOutline(content: string, language: string | undefined, startLine = 1): OutlineResult {
	const family = familyForLanguage(language);
	if (!family) return { entries: [] };

	const lines = content.split("\n");
	const entries: OutlineEntry[] = [];

	// Establish an indentation unit for depth bucketing (smallest non-zero indent).
	let unit = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (isCommentOrBlank(trimmed)) continue;
		const w = indentWidth(line);
		if (w > 0 && (unit === 0 || w < unit)) unit = w;
	}
	if (unit === 0) unit = 1;

	const pattern = DECL_PATTERNS[family];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (isCommentOrBlank(trimmed)) continue;

		let isDecl = pattern.test(family === "go" || family === "c-like" ? trimmed : line);
		if (!isDecl && family === "c-like") {
			if (CLIKE_TYPE.test(trimmed) || CLIKE_ASSIGNED.test(trimmed)) {
				isDecl = true;
			} else if (!CLIKE_CONTROL.test(trimmed) && CLIKE_METHOD.test(trimmed)) {
				isDecl = true;
			}
		}
		if (!isDecl) continue;

		const depth = Math.floor(indentWidth(line) / unit);
		entries.push({ line: startLine + i, depth, text: collapseSignature(trimmed) });
	}

	return { entries, family };
}

/** Trim a trailing opening brace and collapse trailing whitespace for display. */
function collapseSignature(trimmed: string): string {
	let text = trimmed;
	if (text.endsWith("{")) text = text.slice(0, -1).trimEnd();
	return text;
}

export interface RenderOutlineOptions {
	/** Path shown in the header (relative or absolute, caller's choice). */
	path: string;
	/** Total number of lines in the file. */
	totalLines: number;
}

/** Render an outline result as plain text for the model. */
export function renderOutline(result: OutlineResult, options: RenderOutlineOptions): string {
	const { entries } = result;
	const header = `Outline of ${options.path} (${options.totalLines} lines, ${entries.length} symbol${entries.length === 1 ? "" : "s"}):`;
	const width = String(options.totalLines).length;
	const body = entries
		.map((e) => {
			const lineNo = String(e.line).padStart(width, " ");
			const indent = "  ".repeat(e.depth);
			return `${lineNo}  ${indent}${e.text}`;
		})
		.join("\n");
	return `${header}\n${body}\n\n[Outline view: bodies elided. Use read with offset/limit to view a symbol's implementation.]`;
}
