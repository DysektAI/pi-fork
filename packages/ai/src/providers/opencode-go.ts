import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENCODE_GO_MODELS } from "./opencode-go.models.ts";
import { withOpenCodeCompat } from "./opencode-headers.ts";

type OpenCodeGoApi = "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";

export function opencodeGoProvider(): Provider<OpenCodeGoApi> {
	return createProvider<OpenCodeGoApi>({
		id: "opencode-go",
		name: "OpenCode Go",
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		models: Object.values(OPENCODE_GO_MODELS),
		api: {
			"anthropic-messages": withOpenCodeCompat(anthropicMessagesApi()),
			"google-generative-ai": withOpenCodeCompat(googleGenerativeAIApi()),
			"openai-completions": withOpenCodeCompat(openAICompletionsApi()),
			"openai-responses": withOpenCodeCompat(openAIResponsesApi()),
		},
	});
}
