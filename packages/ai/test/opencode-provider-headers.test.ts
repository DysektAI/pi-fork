import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import {
	formatOpenCodeSessionId,
	OPENCODE_CLIENT_USER_AGENT,
	withOpenCodeCompat,
} from "../src/providers/opencode-headers.ts";
import type { Api, Model, ProviderStreams, StreamOptions, Tool, TranscriptContext } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { getCurrentTools, getInitialSystemMessage, normalizeContext } from "../src/utils/transcript.ts";

const model: Model<Api> = {
	id: "test-model",
	name: "Test model",
	api: "test-api",
	provider: "opencode",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const SHAPED_SESSION = "ses_0123456789ab0123456789abcd";
const SHAPED_PATTERN = /^ses_[0-9a-f]{12}[a-z0-9]{14}$/;

function completedStream(): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = fauxAssistantMessage("ok");
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

function recordingStreams(
	capture: (context: TranscriptContext, options: StreamOptions | undefined) => void,
): ProviderStreams {
	return {
		stream: (_model, context, options) => {
			capture(context, options);
			return completedStream();
		},
		streamSimple: (_model, context, options) => {
			capture(context, options);
			return completedStream();
		},
	};
}

describe("formatOpenCodeSessionId", () => {
	it("maps UUID session ids deterministically into the OpenCode shape", () => {
		const mapped = formatOpenCodeSessionId("9d0e4b7a-1f2c-4a3b-8c5d-6e7f8a9b0c1d");
		expect(mapped).toBe("ses_9d0e4b7a1f2c4a3b8c5d6e7f8a");
		expect(mapped).toMatch(SHAPED_PATTERN);
		expect(formatOpenCodeSessionId("9d0e4b7a-1f2c-4a3b-8c5d-6e7f8a9b0c1d")).toBe(mapped);
	});

	it("keeps ids that already carry the OpenCode shape unchanged", () => {
		expect(formatOpenCodeSessionId(SHAPED_SESSION)).toBe(SHAPED_SESSION);
	});

	it("shapes ids without hex material deterministically", () => {
		const mapped = formatOpenCodeSessionId("conversation-1");
		expect(mapped).toMatch(SHAPED_PATTERN);
		expect(formatOpenCodeSessionId("conversation-1")).toBe(mapped);
	});
});

describe("OpenCode provider headers", () => {
	// Regression test for https://github.com/earendil-works/pi/issues/9326
	it.each(["stream", "streamSimple"] as const)(
		"maps sessionId for %s requests even without cache retention",
		(method) => {
			let capturedOptions: StreamOptions | undefined;
			const streams = withOpenCodeCompat(
				recordingStreams((_context, options) => {
					capturedOptions = options;
				}),
			);

			streams[method](model, context, { sessionId: "conversation-1", cacheRetention: "none" });

			expect(capturedOptions?.headers).toEqual({
				"x-opencode-session": formatOpenCodeSessionId("conversation-1"),
				"User-Agent": OPENCODE_CLIENT_USER_AGENT,
			});
		},
	);

	it("preserves a caller session override that already satisfies the gate", () => {
		let capturedOptions: StreamOptions | undefined;
		const streams = withOpenCodeCompat(
			recordingStreams((_context, options) => {
				capturedOptions = options;
			}),
		);

		streams.streamSimple(model, context, {
			sessionId: "generated-value",
			headers: { "X-OpenCode-Session": SHAPED_SESSION },
		});

		expect(capturedOptions?.headers).toEqual({
			"X-OpenCode-Session": SHAPED_SESSION,
			"User-Agent": OPENCODE_CLIENT_USER_AGENT,
		});
	});

	it("preserves a caller suppression of the session header", () => {
		let capturedOptions: StreamOptions | undefined;
		const streams = withOpenCodeCompat(
			recordingStreams((_context, options) => {
				capturedOptions = options;
			}),
		);

		streams.streamSimple(model, context, { sessionId: "generated-value", headers: { "X-OpenCode-Session": null } });

		expect(capturedOptions?.headers).toEqual({
			"X-OpenCode-Session": null,
			"User-Agent": OPENCODE_CLIENT_USER_AGENT,
		});
	});

	it("replaces a caller session override that the gate would reject", () => {
		let capturedOptions: StreamOptions | undefined;
		const streams = withOpenCodeCompat(
			recordingStreams((_context, options) => {
				capturedOptions = options;
			}),
		);

		streams.streamSimple(model, context, {
			sessionId: "conversation-1",
			headers: { "x-opencode-session": "caller-value" },
		});

		expect(capturedOptions?.headers).toEqual({
			"x-opencode-session": formatOpenCodeSessionId("conversation-1"),
			"User-Agent": OPENCODE_CLIENT_USER_AGENT,
		});
	});

	it("fabricates a shaped session header when sessionId is absent", () => {
		const capturedOptions: (StreamOptions | undefined)[] = [];
		const streams = withOpenCodeCompat(
			recordingStreams((_context, options) => {
				capturedOptions.push(options);
			}),
		);

		streams.streamSimple(model, context, {});
		streams.streamSimple(model, context, {});

		const first = capturedOptions[0]?.headers?.["x-opencode-session"];
		const second = capturedOptions[1]?.headers?.["x-opencode-session"];
		expect(first).toMatch(SHAPED_PATTERN);
		expect(second).toMatch(SHAPED_PATTERN);
		expect(second).not.toBe(first);
	});

	it("keeps a caller User-Agent that identifies as an OpenCode client", () => {
		let capturedOptions: StreamOptions | undefined;
		const streams = withOpenCodeCompat(
			recordingStreams((_context, options) => {
				capturedOptions = options;
			}),
		);

		streams.streamSimple(model, context, {
			sessionId: "conversation-1",
			headers: { "User-Agent": "opencode/2.0.0-custom" },
		});

		expect(capturedOptions?.headers).toEqual({
			"x-opencode-session": formatOpenCodeSessionId("conversation-1"),
			"User-Agent": "opencode/2.0.0-custom",
		});
	});

	it("overrides a non-opencode User-Agent with the disclosed OpenCode identity", () => {
		let capturedOptions: StreamOptions | undefined;
		const streams = withOpenCodeCompat(
			recordingStreams((_context, options) => {
				capturedOptions = options;
			}),
		);

		streams.streamSimple(model, context, {
			sessionId: "conversation-1",
			headers: { "User-Agent": "custom-client/1.0" },
		});

		expect(capturedOptions?.headers).toEqual({
			"x-opencode-session": formatOpenCodeSessionId("conversation-1"),
			"User-Agent": OPENCODE_CLIENT_USER_AGENT,
		});
	});

	it.each(["stream", "streamSimple"] as const)(
		"declares inert compat tools on tool-less transcripts for %s requests",
		(method) => {
			let capturedContext: TranscriptContext | undefined;
			const streams = withOpenCodeCompat(
				recordingStreams((captured) => {
					capturedContext = captured;
				}),
			);

			const prompted = normalizeContext({
				systemPrompt: "You are under test.",
				messages: [{ role: "user", content: "hi", timestamp: 0 }],
			});
			streams[method](model, prompted, { sessionId: "conversation-1" });

			expect(getCurrentTools(capturedContext?.messages ?? []).map((tool) => tool.name)).toEqual(["bash", "read"]);
			expect(getInitialSystemMessage(capturedContext?.messages ?? [])?.content).toBe("You are under test.");
		},
	);

	it("pads a single recognized tool up to the gate minimum", () => {
		const declared: Tool = {
			name: "read",
			description: "real read tool",
			parameters: Type.Object({}),
		};
		let capturedContext: TranscriptContext | undefined;
		const streams = withOpenCodeCompat(
			recordingStreams((captured) => {
				capturedContext = captured;
			}),
		);

		const withOneTool = normalizeContext({
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
			tools: [declared],
		});
		streams.streamSimple(model, withOneTool, { sessionId: "conversation-1" });

		const tools = getCurrentTools(capturedContext?.messages ?? []);
		expect(tools.map((tool) => tool.name)).toEqual(["read", "bash"]);
		expect(tools[0]).toEqual(declared);
	});

	it("keeps transcripts with two recognized tools untouched", () => {
		const declared: Tool[] = [
			{ name: "read", description: "real read tool", parameters: Type.Object({}) },
			{ name: "bash", description: "real bash tool", parameters: Type.Object({}) },
		];
		let capturedContext: TranscriptContext | undefined;
		const streams = withOpenCodeCompat(
			recordingStreams((captured) => {
				capturedContext = captured;
			}),
		);

		const withTools = normalizeContext({
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
			tools: declared,
		});
		streams.streamSimple(model, withTools, { sessionId: "conversation-1" });

		expect(getCurrentTools(capturedContext?.messages ?? [])).toEqual(declared);
	});
});
