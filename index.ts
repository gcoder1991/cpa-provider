/**
 * CLIProxyAPI provider for pi 0.84.x.
 *
 * Install: ~/.pi/agent/extensions/cpa-provider/index.ts
 * Configure: /login cpa
 * Optional endpoint override: CPA_BASE_URL=http://127.0.0.1:8317
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "cpa";
const DEFAULT_SERVER_URL = "http://127.0.0.1:8317";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
interface CpaModel {
	id: string;
	name?: string;
	ownedBy?: string;
}

function normalizeServerUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("CLIProxyAPI URL must use http or https");
	}
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "") || "/";
	return url.toString().replace(/\/$/u, "");
}

const serverUrl = normalizeServerUrl(process.env.CPA_BASE_URL ?? DEFAULT_SERVER_URL);
const inferenceUrl = `${serverUrl}/v1`;

async function fetchJson(url: string, apiKey: string | undefined, signal?: AbortSignal): Promise<unknown> {
	const headers = new Headers({ accept: "application/json" });
	if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
	const timeout = AbortSignal.timeout(15_000);
	const response = await fetch(url, {
		headers,
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) throw new Error(`Request failed: HTTP ${response.status}`);
	return response.json();
}

function parseModelList(payload: unknown): CpaModel[] {
	if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
		throw new Error("CLIProxyAPI returned an invalid /v1/models response");
	}
	return (payload as { data: unknown[] }).data.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null || typeof (entry as { id?: unknown }).id !== "string") return [];
		const model = entry as { id: string; name?: unknown; display_name?: unknown; owned_by?: unknown };
		const name =
			typeof model.name === "string"
				? model.name
				: typeof model.display_name === "string"
					? model.display_name
					: undefined;
		return [
			{
				id: model.id,
				...(name ? { name } : {}),
				...(typeof model.owned_by === "string" ? { ownedBy: model.owned_by } : {}),
			},
		];
	});
}

function metadataProviderIds(model: CpaModel): BuiltinProvider[] {
	const value = `${model.ownedBy ?? ""}/${model.id}`.toLowerCase();
	if (value.includes("claude") || value.includes("anthropic")) return ["anthropic"];
	if (value.includes("gemini") || value.includes("google")) return ["google"];
	if (value.includes("glm") || value.includes("zai") || value.includes("z-ai")) return ["zai"];
	if (value.includes("kimi") || value.includes("moonshot")) return ["moonshotai", "kimi-coding"];
	if (value.includes("grok") || value.includes("xai")) return ["xai"];
	if (value.includes("deepseek")) return ["deepseek"];
	if (value.includes("gpt") || value.includes("codex") || value.includes("openai")) {
		return ["openai", "openai-codex"];
	}
	return [];
}

function useResponsesApi(model: CpaModel): boolean {
	const value = `${model.ownedBy ?? ""}/${model.id}`.toLowerCase();
	return (value.includes("openai") || value.includes("gpt") || value.includes("codex")) && !value.includes("image");
}
function loadMetadata(models: readonly CpaModel[]): Map<string, Model<Api>> {
	const providerIds = [...new Set(models.flatMap(metadataProviderIds))];
	return new Map(
		providerIds.flatMap((providerId) =>
			getBuiltinModels(providerId).map((model) => [`${providerId}\0${model.id}`, model]),
		),
	);
}

async function discoverModels(apiKey: string | undefined, signal?: AbortSignal): Promise<Model<Api>[]> {
	const payload = await fetchJson(`${inferenceUrl}/models`, apiKey, signal);
	const models = parseModelList(payload);
	const metadata = loadMetadata(models);
	return models.map((entry) => {
		const providerIds = metadataProviderIds(entry);
		const source = providerIds
			.map((providerId) => metadata.get(`${providerId}\0${entry.id}`))
			.find((model) => model !== undefined);
		// Kimi rejects the OpenAI "developer" role (official moonshotai catalog sets this too)
		const compat = providerIds.includes("moonshotai") ? { supportsDeveloperRole: false } : undefined;
		return {
			id: entry.id,
			name: entry.name ?? source?.name ?? entry.id,
			api: useResponsesApi(entry) ? "openai-responses" : "openai-completions",
			provider: PROVIDER_ID,
			baseUrl: inferenceUrl,
			reasoning: source?.reasoning ?? false,
			thinkingLevelMap: source?.thinkingLevelMap,
			...(source?.compat ?? compat ? { compat: { ...source?.compat, ...compat } } : {}),
			input: source?.input ?? ["text"],
			cost: source?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: source?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: source?.maxTokens ?? DEFAULT_MAX_TOKENS,
		};
	});
}

export default function cpaExtension(pi: ExtensionAPI): void {
	let fastMode = /^(1|true|on)$/iu.test(process.env.CPA_FAST_MODE ?? "");
	const responsesApi = openAIResponsesApi();

	pi.registerCommand("cpa-fast", {
		description: "Toggle OpenAI Fast mode for CPA requests",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, context) => {
			const value = args.trim().toLowerCase();
			if (value === "on") fastMode = true;
			else if (value === "off") fastMode = false;
			else if (value && value !== "status") {
				context.ui.notify("Usage: /cpa-fast on|off|status", "warning");
				return;
			}
			context.ui.notify(`CPA Fast mode: ${fastMode ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("cpa-info", {
		description: "Show CPA provider status",
		handler: async (_args, context) => {
			const model = context.model?.provider === PROVIDER_ID ? context.model.id : "not selected";
			context.ui.notify(
				[
					`CPA_BASE_URL: ${serverUrl}`,
					`Fast mode: ${fastMode ? "on" : "off"}`,
					`Model: ${model}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerProvider(PROVIDER_ID, {
		name: "CLIProxyAPI",
		baseUrl: inferenceUrl,
		apiKey: "$CPA_API_KEY",
		api: "openai-responses",
		models: [],
		streamSimple: (model, context, options) =>
			responsesApi.streamSimple(model, context, {
				...options,
				onPayload: async (payload, currentModel) => {
					const transformed = (await options?.onPayload?.(payload, currentModel)) ?? payload;
					if (!fastMode || typeof transformed !== "object" || transformed === null) return transformed;
					return { ...transformed, service_tier: "priority" };
				},
			}),
		refreshModels: async (context) => {
			const cached = (context.stored?.models ?? []).filter(
				(model): model is Model<Api> =>
					model.provider === PROVIDER_ID &&
					(model.api === "openai-responses" || model.api === "openai-completions"),
			);
			if (!context.allowNetwork || context.signal.aborted) return cached;
			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const models = await discoverModels(apiKey, context.signal);
			if (!context.signal.aborted) {
				await context.publish({ persist: { models, checkedAt: Date.now() } });
			}
			return models;
		},
	});
}
