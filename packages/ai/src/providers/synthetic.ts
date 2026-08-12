import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";
import { SYNTHETIC_MODELS } from "./synthetic.models.ts";
import { SYNTHETIC_BASE_URL, SYNTHETIC_COMPAT } from "./synthetic-config.ts";

type SyntheticModelResponse = {
	id?: string;
	name?: string;
	context_length?: number;
	max_output_length?: number;
	input_modalities?: string[];
	supported_features?: string[];
	reasoning_parameters?: { efforts?: string[] };
	pricing?: {
		prompt?: string | number;
		completion?: string | number;
		input_cache_reads?: string | number;
		input_cache_writes?: string | number;
	};
};

type SyntheticModelsResponse = { data?: SyntheticModelResponse[] };

function parsePrice(value: string | number | undefined): number {
	const numeric = typeof value === "number" ? value : Number.parseFloat(value?.replace(/^\$/u, "") ?? "0");
	return Number.isFinite(numeric) ? numeric * 1_000_000 : 0;
}

function createThinkingLevelMap(
	efforts: readonly string[] | undefined,
): Model<"openai-completions">["thinkingLevelMap"] {
	if (!efforts || efforts.length === 0) return undefined;
	const supports = new Set(efforts.map((effort) => effort.toLowerCase()));
	const map: NonNullable<Model<"openai-completions">["thinkingLevelMap"]> = {};
	if (supports.has("none")) map.off = "none";
	else map.off = null;
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		map[level] = supports.has(level) ? level : null;
	}
	return map;
}

function parseSyntheticModel(value: SyntheticModelResponse): Model<"openai-completions"> | undefined {
	if (!value.id || !value.supported_features?.includes("tools")) return undefined;
	const input = value.input_modalities?.includes("image") ? (["text", "image"] as const) : (["text"] as const);
	const reasoning =
		value.supported_features.includes("reasoning") || (value.reasoning_parameters?.efforts?.length ?? 0) > 0;
	return {
		id: value.id,
		name: value.name ?? value.id,
		api: "openai-completions",
		provider: "synthetic",
		baseUrl: SYNTHETIC_BASE_URL,
		reasoning,
		...(reasoning ? { thinkingLevelMap: createThinkingLevelMap(value.reasoning_parameters?.efforts) } : {}),
		input: [...input],
		cost: {
			input: parsePrice(value.pricing?.prompt),
			output: parsePrice(value.pricing?.completion),
			cacheRead: parsePrice(value.pricing?.input_cache_reads),
			cacheWrite: parsePrice(value.pricing?.input_cache_writes),
		},
		contextWindow: value.context_length ?? 128000,
		maxTokens: value.max_output_length ?? 65536,
		compat: SYNTHETIC_COMPAT,
	};
}

async function fetchSyntheticModels(context: RefreshModelsContext): Promise<readonly Model<"openai-completions">[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	const response = await fetch(`${SYNTHETIC_BASE_URL}/models`, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
		signal: context.signal,
	});
	if (!response.ok) throw new Error(`Synthetic model catalog request failed: ${response.status}`);
	const payload = (await response.json()) as SyntheticModelsResponse;
	return (payload.data ?? []).flatMap((model) => {
		const parsed = parseSyntheticModel(model);
		return parsed ? [parsed] : [];
	});
}

export function syntheticProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "synthetic",
		name: "Synthetic",
		baseUrl: SYNTHETIC_BASE_URL,
		auth: { apiKey: envApiKeyAuth("Synthetic API key", ["SYNTHETIC_API_KEY"]) },
		models: Object.values(SYNTHETIC_MODELS),
		fetchModels: fetchSyntheticModels,
		api: openAICompletionsApi(),
	});
}

export { SYNTHETIC_BASE_URL, SYNTHETIC_COMPAT } from "./synthetic-config.ts";
export { parseSyntheticModel };
