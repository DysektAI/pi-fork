import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Usage } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		beta: { messages: { create: () => ({ asResponse: async () => response }) } },
	} as unknown as Anthropic;
}

function usageEvents(
	startUsage: Record<string, number | null>,
	deltaUsage: Record<string, number | null>,
): Array<{ event: string; data: string }> {
	return [
		{
			event: "message_start",
			data: JSON.stringify({ type: "message_start", message: { id: "msg_test", usage: startUsage } }),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: deltaUsage,
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
}

async function runTurn(startUsage: Record<string, number | null>, deltaUsage: Record<string, number | null>) {
	const model = getModel("anthropic", "claude-opus-4-8");
	const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
	const response = createSseResponse(usageEvents(startUsage, deltaUsage));
	const stream = streamAnthropic(model, context, { client: createFakeAnthropicClient(response) });
	let initialUsage: Usage | undefined;
	for await (const event of stream) {
		if (event.type === "text_start") initialUsage = structuredClone(event.partial.usage);
	}
	const result = await stream.result();
	expect(result.stopReason).toBe("stop");
	return { ...result, initialUsage };
}

describe("Anthropic disjoint usage buckets", () => {
	// Anthropic input_tokens excludes both cache buckets:
	// https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance
	it("preserves uncached input independently of cache reads and writes", async () => {
		const result = await runTurn(
			{ input_tokens: 24218, output_tokens: 0, cache_read_input_tokens: 20309, cache_creation_input_tokens: 3907 },
			{ input_tokens: 24218, output_tokens: 377, cache_read_input_tokens: 20309, cache_creation_input_tokens: 3907 },
		);

		expect(result.initialUsage?.input).toBe(24218);
		expect(result.initialUsage?.totalTokens).toBe(24218 + 20309 + 3907);
		expect(result.usage.input).toBe(24218);
		expect(result.usage.cacheRead).toBe(20309);
		expect(result.usage.cacheWrite).toBe(3907);
		expect(result.usage.totalTokens).toBe(24218 + 377 + 20309 + 3907);
	});

	it("preserves input when a delta updates cache usage without input_tokens", async () => {
		const result = await runTurn(
			{ input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			{ output_tokens: 5, cache_read_input_tokens: 800, cache_creation_input_tokens: 200 },
		);

		expect(result.usage.input).toBe(1000);
		expect(result.usage.cacheRead).toBe(800);
		expect(result.usage.cacheWrite).toBe(200);
		expect(result.usage.totalTokens).toBe(2005);
	});

	it("preserves input even when the cached prefix is larger", async () => {
		const result = await runTurn(
			{ input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
			{ input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
		);

		expect(result.usage.input).toBe(50);
		expect(result.usage.totalTokens).toBe(855);
	});

	it("prices uncached input and cache buckets separately", async () => {
		const result = await runTurn(
			{ input_tokens: 24218, output_tokens: 0, cache_read_input_tokens: 20309, cache_creation_input_tokens: 3907 },
			{ input_tokens: 24218, output_tokens: 0, cache_read_input_tokens: 20309, cache_creation_input_tokens: 3907 },
		);

		const { cost } = getModel("anthropic", "claude-opus-4-8");
		expect(result.usage.cost.input).toBeCloseTo((24218 * cost.input) / 1_000_000, 10);
		expect(result.usage.cost.cacheRead).toBeCloseTo((20309 * cost.cacheRead) / 1_000_000, 10);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((3907 * cost.cacheWrite) / 1_000_000, 10);
		expect(result.usage.cost.total).toBeCloseTo(
			result.usage.cost.input + result.usage.cost.cacheRead + result.usage.cost.cacheWrite,
			10,
		);
	});

	it("accepts updated input_tokens without subtracting cache buckets", async () => {
		const result = await runTurn(
			{ input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 800, cache_creation_input_tokens: 200 },
			{ input_tokens: 70, output_tokens: 5 },
		);
		expect(result.usage.input).toBe(70);
		expect(result.usage.totalTokens).toBe(1075);
	});

	it("preserves prior usage when a delta has null usage fields", async () => {
		const result = await runTurn(
			{ input_tokens: 50, output_tokens: 2, cache_read_input_tokens: 800, cache_creation_input_tokens: 200 },
			{ input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null },
		);
		expect(result.usage.input).toBe(50);
		expect(result.usage.output).toBe(2);
		expect(result.usage.cacheRead).toBe(800);
		expect(result.usage.cacheWrite).toBe(200);
		expect(result.usage.totalTokens).toBe(1052);
	});

	it("accepts explicit zero usage fields instead of preserving prior values", async () => {
		const result = await runTurn(
			{ input_tokens: 50, output_tokens: 2, cache_read_input_tokens: 800, cache_creation_input_tokens: 200 },
			{ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		);
		expect(result.initialUsage?.input).toBe(50);
		expect(result.usage.input).toBe(0);
		expect(result.usage.output).toBe(0);
		expect(result.usage.cacheRead).toBe(0);
		expect(result.usage.cacheWrite).toBe(0);
		expect(result.usage.totalTokens).toBe(0);
		expect(result.usage.cost.total).toBe(0);
	});

	it("keeps uncached-only usage unchanged", async () => {
		const result = await runTurn({ input_tokens: 50, output_tokens: 0 }, { output_tokens: 5 });
		expect(result.usage.input).toBe(50);
		expect(result.usage.totalTokens).toBe(55);
	});
});
