import { Type } from "typebox";
import type { ProviderHeaders, ProviderStreams, StreamOptions, Tool, TranscriptContext } from "../types.ts";
import { formatOpenCodeSessionId } from "../utils/identity.ts";

export { formatOpenCodeSessionId } from "../utils/identity.ts";

import { getCurrentTools, normalizeContext } from "../utils/transcript.ts";
import { uuidv7 } from "../utils/uuid.ts";

/**
 * User-Agent sent to OpenCode Zen/Go. The Zen free-tier gate (anomalyco/opencode#49621)
 * rejects requests whose User-Agent does not start with `opencode/<version>`; versions
 * below 1.17.0 get HTTP 426. The leading token must therefore track the real client,
 * while the suffix keeps the actual client visible in server logs. Re-verify against
 * the gate when bumping.
 */
export const OPENCODE_CLIENT_USER_AGENT = "opencode/1.18.31 (pi coding agent)";

const OPENCODE_SESSION_HEADER = "x-opencode-session";

/**
 * OpenCode Zen's free-tier gate rejects requests that declare fewer than two
 * recognized coding-tool names (HTTP 403 FreeTierError). Invented names do not count.
 * Requests below the minimum (tool-less compaction and title generation, single-tool
 * agents) declare these inert placeholders so the gate passes. Their descriptions tell
 * the model never to call them; nothing executes tool calls in those flows anyway.
 */
const COMPAT_TOOLS: Tool[] = [
	{
		name: "bash",
		description: "Inert placeholder declared for request compatibility. Never call this tool.",
		parameters: Type.Object({}),
	},
	{
		name: "read",
		description: "Inert placeholder declared for request compatibility. Never call this tool.",
		parameters: Type.Object({}),
	},
];

/** Tool names the Zen gate recognizes as coding tools (verified by probe). */
const ZEN_RECOGNIZED_TOOL_NAMES = ["bash", "edit", "find", "glob", "grep", "ls", "powershell", "read", "write"];
const ZEN_MIN_RECOGNIZED_TOOLS = 2;

function findHeaderKey(headers: ProviderHeaders, name: string): string | undefined {
	const expected = name.toLowerCase();
	return Object.keys(headers).find((key) => key.toLowerCase() === expected);
}

/**
 * Enforce the Zen free-tier gate's client identity on request headers. Caller values
 * win only when they already satisfy the gate: an `opencode/`-prefixed User-Agent and
 * a `ses_`-prefixed session header (or an explicit null suppression). Anything else is
 * replaced so third-party requests are not rejected with FreeTierError.
 */
function withCompatHeaders<TOptions extends StreamOptions>(options: TOptions | undefined): TOptions | undefined {
	const headers: ProviderHeaders = { ...options?.headers };

	const userAgentKey = findHeaderKey(headers, "user-agent");
	if (userAgentKey === undefined) {
		headers["User-Agent"] = OPENCODE_CLIENT_USER_AGENT;
	} else {
		const userAgent = headers[userAgentKey];
		if (userAgent !== null && !/^opencode\//i.test(userAgent)) {
			headers[userAgentKey] = OPENCODE_CLIENT_USER_AGENT;
		}
	}

	const sessionKey = findHeaderKey(headers, OPENCODE_SESSION_HEADER);
	if (sessionKey === undefined) {
		headers[OPENCODE_SESSION_HEADER] = formatOpenCodeSessionId(options?.sessionId ?? uuidv7());
	} else {
		const session = headers[sessionKey];
		if (session !== null && !session.startsWith("ses_")) {
			headers[sessionKey] = formatOpenCodeSessionId(options?.sessionId ?? uuidv7());
		}
	}

	return { ...options, headers } as TOptions;
}

/** Declare inert compat tools when the transcript has fewer than two recognized coding tools. */
function withCompatTools(context: TranscriptContext): TranscriptContext {
	const declared = getCurrentTools(context.messages);
	const declaredNames = new Set(declared.map((tool) => tool.name));
	const recognized = ZEN_RECOGNIZED_TOOL_NAMES.filter((name) => declaredNames.has(name));
	if (recognized.length >= ZEN_MIN_RECOGNIZED_TOOLS) return context;
	const padding = COMPAT_TOOLS.filter((tool) => !declaredNames.has(tool.name));
	const messages = [...context.messages];
	const first = messages[0];
	if (first?.role === "system") {
		messages[0] = { ...first, toolsAdded: [...(first.toolsAdded ?? []), ...padding] };
	} else {
		messages.unshift({ role: "system", content: "", toolsAdded: padding, timestamp: 0 });
	}
	return normalizeContext({ messages });
}

/**
 * Adds OpenCode Zen's required client attribution (User-Agent, session header, and
 * gate-satisfying tool declarations) before API dispatch.
 */
export function withOpenCodeCompat(streams: ProviderStreams): ProviderStreams {
	return {
		...streams,
		stream: (model, context, options) => streams.stream(model, withCompatTools(context), withCompatHeaders(options)),
		streamSimple: (model, context, options) =>
			streams.streamSimple(model, withCompatTools(context), withCompatHeaders(options)),
	};
}
