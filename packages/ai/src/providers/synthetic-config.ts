import type { OpenAICompletionsCompat } from "../types.ts";

export const SYNTHETIC_BASE_URL = "https://api.synthetic.new/openai/v1";

export const SYNTHETIC_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	maxTokensField: "max_completion_tokens",
	supportsStrictMode: true,
	supportsLongCacheRetention: false,
};
