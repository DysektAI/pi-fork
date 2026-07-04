import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	status: 401,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const error = new Error(`${mockState.status} status code (no body)`) as Error & { status: number };
					error.status = mockState.status;
					return {
						withResponse: async () => {
							throw error;
						},
					};
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: Model<"openai-completions"> = {
	id: "custom-model",
	name: "Custom Model",
	api: "openai-completions",
	provider: "custom-provider",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

describe("openai-completions auth errors", () => {
	beforeEach(() => {
		mockState.status = 401;
	});

	it("explains 401 API key failures", async () => {
		const message = await complete(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "bad-key" },
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(
			'Authentication failed (HTTP 401) for provider "custom-provider". The API key was rejected; check that it is valid and not expired.',
		);
	});

	it("names the API key source when provided", async () => {
		const message = await complete(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "bad-key", apiKeySource: "the environment variable CANOPYWAVE_KEY" },
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(
			'Authentication failed (HTTP 401) for provider "custom-provider". The API key (from the environment variable CANOPYWAVE_KEY) was rejected; check that it is valid and not expired.',
		);
		expect(message.errorMessage).not.toContain("bad-key");
	});

	it("explains 403 API key failures", async () => {
		mockState.status = 403;

		const message = await complete(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "bad-key" },
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Authentication failed (HTTP 403)");
		expect(message.errorMessage).toContain('provider "custom-provider"');
	});
});
