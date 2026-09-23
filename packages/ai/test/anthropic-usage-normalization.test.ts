import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

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
	startUsage: Record<string, number>,
	deltaUsage: Record<string, number>,
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

async function runTurn(startUsage: Record<string, number>, deltaUsage: Record<string, number>) {
	const model = getModel("anthropic", "claude-opus-4-8");
	const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
	const response = createSseResponse(usageEvents(startUsage, deltaUsage));
	return streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();
}

describe("Anthropic usage bucket normalization", () => {
	it("stores fresh-only input when input_tokens overlaps the cache buckets", async () => {
		// Mirrors a live cached turn: input_tokens is the TOTAL prompt size.
		const result = await runTurn(
			{ input_tokens: 24218, output_tokens: 0, cache_read_input_tokens: 20309, cache_creation_input_tokens: 3907 },
			{ input_tokens: 24218, output_tokens: 377, cache_read_input_tokens: 20309, cache_creation_input_tokens: 3907 },
		);

		expect(result.usage.input).toBe(2);
		expect(result.usage.cacheRead).toBe(20309);
		expect(result.usage.cacheWrite).toBe(3907);
		// No double counting: total = fresh + output + read + write.
		expect(result.usage.totalTokens).toBe(2 + 377 + 20309 + 3907);
	});

	it("re-derives fresh input when a delta omits input_tokens (proxy behavior)", async () => {
		const result = await runTurn(
			{ input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			{ output_tokens: 5, cache_read_input_tokens: 800 } as Record<string, number>,
		);

		expect(result.usage.input).toBe(200);
		expect(result.usage.cacheRead).toBe(800);
	});

	it("clamps fresh input at zero instead of going negative", async () => {
		const result = await runTurn(
			{ input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
			{ input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
		);

		expect(result.usage.input).toBe(0);
	});

	it("prices only fresh input at the input rate", async () => {
		// claude-opus-4-8: input 5/Mtok. 2 fresh tokens -> 1e-5, not 24218 * rate.
		const result = await runTurn(
			{ input_tokens: 24218, output_tokens: 0, cache_read_input_tokens: 20309, cache_creation_input_tokens: 3907 },
			{ input_tokens: 24218, output_tokens: 0, cache_read_input_tokens: 20309, cache_creation_input_tokens: 3907 },
		);

		expect(result.usage.cost.input).toBeCloseTo(0.00001, 10);
	});
});
