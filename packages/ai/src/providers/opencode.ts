import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENCODE_MODELS } from "./opencode.models.ts";
import { withOpenCodeCompat } from "./opencode-headers.ts";

export function opencodeProvider(): Provider<
	"anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses"
> {
	return createProvider({
		id: "opencode",
		name: "OpenCode Zen",
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		models: Object.values(OPENCODE_MODELS),
		api: {
			"anthropic-messages": withOpenCodeCompat(anthropicMessagesApi()),
			"google-generative-ai": withOpenCodeCompat(googleGenerativeAIApi()),
			"openai-completions": withOpenCodeCompat(openAICompletionsApi()),
			"openai-responses": withOpenCodeCompat(openAIResponsesApi()),
		},
	});
}
