/**
 * CLIProxyAPI provider for pi 0.80.x.
 *
 * Install: ~/.pi/agent/extensions/cpa-provider/index.ts
 * Configure: /login cpa
 * Optional endpoint override: CPA_BASE_URL=http://127.0.0.1:8317
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "cpa";
const DEFAULT_SERVER_URL = "http://127.0.0.1:8317";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const CATALOG_BASE_URL = "https://pi.dev";

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

function metadataProviderIds(model: CpaModel): string[] {
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

function parseCatalog(payload: unknown): Model<Api>[] {
	const entries = Array.isArray(payload)
		? payload
		: typeof payload === "object" && payload !== null && "models" in payload && Array.isArray(payload.models)
			? payload.models
			: typeof payload === "object" && payload !== null
				? Object.values(payload)
				: [];
	return entries.filter(
		(entry): entry is Model<Api> =>
			typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string",
	);
}

async function loadMetadata(models: readonly CpaModel[], signal?: AbortSignal): Promise<Map<string, Model<Api>>> {
	const providerIds = [...new Set(models.flatMap(metadataProviderIds))];
	const catalogs = await Promise.all(
		providerIds.map(async (providerId) => {
			try {
				const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, CATALOG_BASE_URL);
				return [providerId, parseCatalog(await fetchJson(url.toString(), undefined, signal))] as const;
			} catch {
				return [providerId, []] as const;
			}
		}),
	);
	return new Map(catalogs.flatMap(([providerId, entries]) => entries.map((model) => [`${providerId}\0${model.id}`, model])));
}

async function discoverModels(apiKey: string | undefined, signal?: AbortSignal): Promise<Model<"openai-completions">[]> {
	const payload = await fetchJson(`${inferenceUrl}/models`, apiKey, signal);
	const models = parseModelList(payload);
	const metadata = await loadMetadata(models, signal);
	return models.map((entry) => {
		const source = metadataProviderIds(entry)
			.map((providerId) => metadata.get(`${providerId}\0${entry.id}`))
			.find((model) => model !== undefined);
		return {
			id: entry.id,
			name: entry.name ?? source?.name ?? entry.id,
			api: "openai-completions",
			provider: PROVIDER_ID,
			baseUrl: inferenceUrl,
			reasoning: source?.reasoning ?? false,
			thinkingLevelMap: source?.thinkingLevelMap,
			input: source?.input ?? ["text"],
			cost: source?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: source?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: source?.maxTokens ?? DEFAULT_MAX_TOKENS,
		};
	});
}

export default function cpaExtension(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "CLIProxyAPI",
		baseUrl: inferenceUrl,
		apiKey: "$CPA_API_KEY",
		api: "openai-completions",
		models: [],
		refreshModels: async (context) => {
			const stored = await context.store.read();
			const cached = (stored?.models ?? []).filter(
				(model): model is Model<"openai-completions"> =>
					model.provider === PROVIDER_ID && model.api === "openai-completions",
			);
			if (!context.allowNetwork || context.signal?.aborted) return cached;
			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const models = await discoverModels(apiKey, context.signal);
			if (!context.signal?.aborted) await context.store.write({ models, checkedAt: Date.now() });
			return models;
		},
	});
}
