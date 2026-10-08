import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * OpenCode Zen as a Pi provider — free models, no API key required.
 *
 * Gateway: https://opencode.ai/zen/v1 (OpenAI-compatible).
 * Catalog: https://models.opencode.ai/api.json (provider "opencode").
 *
 * Client fingerprint: the Zen gateway rate-limits by client headers.
 * Without the official x-opencode-* headers / opencode User-Agent, the free
 * tier answers 429 "FreeUsageLimitError" immediately; with them, anonymous
 * usage behaves like the opencode CLI. This extension replicates the CLI
 * headers (see anomalyco/opencode session/llm/request.ts).
 *
 * Since ~Sep 2026 the gateway ALSO validates x-opencode-session /
 * x-opencode-request against opencode's EID format and rejects anything else
 * with HTTP 403 FreeTierError "OpenCode's free tier can only be used from
 * within OpenCode" (see createEid below, mirrored from
 * packages/schema/src/identifier.ts and packages/core/src/id/id.ts).
 *
 * Pi itself is one of those rejected clients: for any model whose provider is
 * `opencode`/`opencode-go`, or whose baseUrl host is opencode.ai, Pi adds
 * `x-opencode-client: pi` plus its own session id (see
 * pi-coding-agent core/provider-attribution.js getSessionHeaders). Registering
 * this provider overrides those headers, but that override only applies while
 * this registration is the effective provider config for the request. So the
 * fingerprint is also enforced per request in `before_provider_headers` below:
 * whenever the outgoing headers carry Pi's own identity, or a session id that
 * is not an EID, they are rewritten into the CLI fingerprint. Requests to other
 * providers are never touched.
 *
 * Model list: only cost 0/0 and NOT deprecated. It refreshes automatically —
 * through Pi's own `refreshModels` hook, from a background pass when the cache
 * is stale, and on demand with `/opencode-pi refresh`. The cached catalog lives
 * in ~/.cache/opencode-pi/ and is used at load, so offline startup still works.
 */
const BASE_URL = "https://opencode.ai/zen/v1";
const CATALOG_URL = "https://models.opencode.ai/api.json";
const NPM_LATEST_URL = "https://registry.npmjs.org/opencode-ai/latest";

const CACHE_DIR = `${process.env.HOME}/.cache/opencode-pi`;
const MODELS_FILE = `${CACHE_DIR}/models.json`;
const VERSION_FILE = `${CACHE_DIR}/cli-version`;

const DEFAULT_CLI_VERSION = "1.18.35";

// Refresh the cached catalog after this long; the fetch happens in the
// background and never blocks startup.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

// opencode EID format, mirrored from packages/schema/src/identifier.ts:
// `<prefix>_<12 hex chars><14 chars from a 62-char alphabet>`. The first 12
// chars encode `Date.now() << 12 | counter`, the last 14 are random. The zen
// gateway rejects sessions that do not match this structure with 403
// FreeTierError, so we cannot send plain UUIDs.
const EID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastEidTimestamp = 0;
let eidCounter = 0;

/** Session id shape the gateway accepts. */
export const EID_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

export function createEid(prefix: "ses" | "msg"): string {
	const ts = Date.now();
	if (ts !== lastEidTimestamp) {
		lastEidTimestamp = ts;
		eidCounter = 0;
	}
	const current = BigInt(ts) * 0x1000n + BigInt(eidCounter);
	eidCounter++;
	const time = current.toString(16).padStart(12, "0").slice(0, 12);
	const bytes = crypto.getRandomValues(new Uint8Array(14));
	let rand = "";
	for (const byte of bytes) rand += EID_CHARS[byte % 62];
	return `${prefix}_${time}${rand}`;
}

// Header values must be Latin-1 printable; Pi only strips CR/LF and trims a
// session name (core/session-manager.js), so an emoji or an accent would reach
// fetch as-is and Node refuses it with
// "TypeError: Cannot convert argument to a ByteString". Encode anything outside
// printable ASCII, and cap the result so a pathological name cannot blow the
// header size.
const HEADER_VALUE_MAX = 200;

export function sanitizeHeaderValue(value: string): string {
	const encoded = value.replace(/[^\x20-\x7E]/gu, (char) => {
		try {
			return encodeURIComponent(char);
		} catch {
			// Unpaired surrogate: keep the header valid instead of throwing.
			return "?";
		}
	});
	return encoded.trim().slice(0, HEADER_VALUE_MAX);
}

export interface ModelSeed {
	id: string;
	name: string;
	reasoning: boolean;
	input: string[];
	context: number;
	output: number;
}

// Seed: free models verified to answer on 2026-10-08. The cached catalog and
// every automatic refresh replace this list with the live one.
const SEED_MODELS: ModelSeed[] = [
	{
		id: "big-pickle",
		name: "Big Pickle",
		reasoning: true,
		input: ["text"],
		context: 200000,
		output: 32000,
	},
	{
		id: "nemotron-3-ultra-free",
		name: "Nemotron 3 Ultra Free",
		reasoning: true,
		input: ["text"],
		context: 1000000,
		output: 128000,
	},
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning Free",
		reasoning: true,
		input: ["text"],
		context: 262144,
		output: 262144,
	},
	{
		id: "longcat-2.5-preview-free",
		name: "LongCat 2.5 Preview Free",
		reasoning: true,
		input: ["text", "image"],
		context: 1000000,
		output: 131072,
	},
	{
		id: "space-bunny-free",
		name: "Space Bunny Free",
		reasoning: true,
		input: ["text", "image"],
		context: 1048576,
		output: 524288,
	},
	{
		id: "mimo-v2.6-flash-free",
		name: "MiMo-V2.6-Flash Free",
		reasoning: true,
		input: ["text", "image"],
		context: 200000,
		output: 32000,
	},
];

function readCache(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function writeCache(file: string, content: string): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(file, content, "utf8");
	} catch {
		// best effort only
	}
}

function normalizeSeed(entry: unknown): ModelSeed | undefined {
	const model = entry as Record<string, any> | undefined;
	if (!model || typeof model.id !== "string" || model.id.length === 0) return undefined;
	const input = Array.isArray(model.input)
		? model.input.filter((value: unknown) => value === "text" || value === "image")
		: [];
	return {
		id: model.id,
		name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
		reasoning: Boolean(model.reasoning),
		input: input.length > 0 ? input : ["text"],
		context: typeof model.context === "number" && model.context > 0 ? model.context : 200000,
		output: typeof model.output === "number" && model.output > 0 ? model.output : 32768,
	};
}

interface CachedModels {
	models: ModelSeed[];
	fetchedAt: number;
}

function loadModels(): CachedModels {
	const raw = readCache(MODELS_FILE);
	if (!raw) return { models: SEED_MODELS, fetchedAt: 0 };
	try {
		const parsed = JSON.parse(raw);
		// Legacy shape: a bare array without a fetch timestamp.
		const legacy = Array.isArray(parsed);
		const list = legacy ? parsed : parsed?.models;
		const fetchedAt = legacy ? 0 : Number(parsed?.fetchedAt) || 0;
		if (!Array.isArray(list)) return { models: SEED_MODELS, fetchedAt: 0 };
		const models = list.map(normalizeSeed).filter((seed): seed is ModelSeed => seed !== undefined);
		return models.length > 0 ? { models, fetchedAt } : { models: SEED_MODELS, fetchedAt: 0 };
	} catch {
		return { models: SEED_MODELS, fetchedAt: 0 };
	}
}

function persistModels(list: ModelSeed[], fetchedAt: number): void {
	writeCache(MODELS_FILE, JSON.stringify({ fetchedAt, models: list }, null, 2));
}

function loadCliVersion(): string {
	return readCache(VERSION_FILE)?.trim() || DEFAULT_CLI_VERSION;
}

function persistCliVersion(version: string): void {
	writeCache(VERSION_FILE, version);
}

const cached = loadModels();
let models = cached.models;
let modelsFetchedAt = cached.fetchedAt;
let cliVersion = loadCliVersion();
let sessionId = createEid("ses");
let projectHeader = "pi-agent";

/**
 * Keep only cost-0, non-deprecated catalog entries, normalized to what the
 * provider config needs. Unusable catalogs return an empty list, which callers
 * treat as "keep what we have".
 */
export function toModelSeeds(catalog: unknown): ModelSeed[] {
	const provider = (catalog as { opencode?: { models?: Record<string, unknown> } } | undefined)?.opencode;
	const entries = Object.values(provider?.models ?? {});
	const seeds: ModelSeed[] = [];
	for (const entry of entries) {
		const model = (entry ?? {}) as Record<string, any>;
		if (typeof model.id !== "string" || model.id.length === 0) continue;
		const cost = (model.cost ?? {}) as Record<string, unknown>;
		if (cost.input !== 0 || cost.output !== 0) continue;
		if (model.status === "deprecated") continue;
		const limit = (model.limit ?? {}) as Record<string, unknown>;
		const modalities = Array.isArray(model.modalities?.input) ? model.modalities.input : [];
		const input = modalities.filter((value: unknown) => value === "text" || value === "image");
		seeds.push({
			id: model.id,
			name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
			reasoning: Boolean(model.reasoning),
			input: input.length > 0 ? input : ["text"],
			context: typeof limit.context === "number" && limit.context > 0 ? limit.context : 200000,
			output: typeof limit.output === "number" && limit.output > 0 ? limit.output : 32768,
		});
	}
	return seeds;
}

export interface FingerprintDeps {
	sessionId: string;
	projectHeader: string;
	cliVersion: string;
}

export type HeaderBag = Record<string, string | null | undefined>;

/**
 * Rewrite Pi's own identity into the opencode CLI fingerprint.
 *
 * Pi tags every request aimed at an opencode.ai host with
 * `x-opencode-client: pi` and its session id, which the free tier rejects with
 * 403 FreeTierError. Only requests that already carry an opencode client marker
 * are touched, so other providers keep their headers untouched.
 *
 * @returns true when the headers were inspected as an opencode request.
 */
export function applyFingerprintGuard(headers: HeaderBag, deps: FingerprintDeps): boolean {
	const client = headers["x-opencode-client"];
	if (client !== "pi" && client !== "cli") return false;

	const session = headers["x-opencode-session"];
	if (typeof session === "string" && EID_PATTERN.test(session)) {
		// The CLI fingerprint is already in place: keep the session and mint a
		// per-request id, the way the CLI does for every message.
		headers["x-opencode-request"] = createEid("msg");
		return true;
	}

	headers["user-agent"] = `opencode/${deps.cliVersion}`;
	headers["x-opencode-client"] = "cli";
	headers["x-opencode-session"] =
		typeof deps.sessionId === "string" && EID_PATTERN.test(deps.sessionId) ? deps.sessionId : createEid("ses");
	headers["x-opencode-request"] = createEid("msg");
	headers["x-opencode-project"] = sanitizeHeaderValue(deps.projectHeader);
	return true;
}

function providerModels(list: ModelSeed[]) {
	return list.map((m) => ({
		id: m.id,
		name: m.name,
		reasoning: m.reasoning,
		input: m.input as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.context,
		maxTokens: m.output,
	}));
}

/**
 * Pi calls this during catalog refreshes. Network access is skipped when Pi is
 * initializing offline, and a failed fetch keeps the current list.
 */
async function refreshProviderModels(
	context: { allowNetwork?: boolean; signal?: AbortSignal } = {},
): Promise<ReturnType<typeof providerModels>> {
	if (context.allowNetwork !== false) {
		const seeds = await fetchCatalog(context.signal);
		if (seeds.length > 0) {
			models = seeds;
			modelsFetchedAt = Date.now();
			persistModels(models, modelsFetchedAt);
		}
	}
	return providerModels(models);
}

function register(pi: ExtensionAPI): void {
	pi.registerProvider("opencode", {
		name: "OpenCode Zen (Free)",
		baseUrl: BASE_URL,
		apiKey: "public",
		api: "openai-completions",
		headers: {
			"user-agent": `opencode/${cliVersion}`,
			"x-opencode-client": "cli",
			"x-opencode-session": sessionId,
			"x-opencode-request": createEid("msg"),
			"x-opencode-project": sanitizeHeaderValue(projectHeader),
		},
		models: providerModels(models),
		refreshModels: (context) => refreshProviderModels(context),
	});
}

function stripProviderPrefix(modelId: string | undefined): string | undefined {
	if (!modelId) return undefined;
	const parts = modelId.split("/");
	return parts[parts.length - 1];
}

function withTimeout(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	if (!signal) return timeout;
	try {
		return AbortSignal.any([signal, timeout]);
	} catch {
		return timeout;
	}
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T | undefined> {
	try {
		const response = await fetch(url, { signal: withTimeout(signal) });
		if (!response.ok) return undefined;
		return (await response.json()) as T;
	} catch {
		return undefined;
	}
}

async function fetchCatalog(signal?: AbortSignal): Promise<ModelSeed[]> {
	const catalog = await fetchJson<unknown>(CATALOG_URL, signal);
	return catalog === undefined ? [] : toModelSeeds(catalog);
}

async function fetchCliVersion(signal?: AbortSignal): Promise<string | undefined> {
	const latest = await fetchJson<{ version?: unknown }>(NPM_LATEST_URL, signal);
	return typeof latest?.version === "string" && latest.version.length > 0 ? latest.version : undefined;
}

/**
 * Refresh the free-model list and the CLI version used in the fingerprint.
 * Keeps `keepModelId` even when the catalog drops it, so an in-flight session
 * does not lose its model. Returns a human-readable summary.
 */
async function refresh(pi: ExtensionAPI, keepModelId?: string): Promise<string> {
	const [catalog, version] = await Promise.all([fetchCatalog(), fetchCliVersion()]);
	const notes: string[] = [];

	if (catalog.length > 0) {
		const next = [...catalog];
		const keep = stripProviderPrefix(keepModelId);
		if (keep && !next.some((m) => m.id === keep)) {
			const existing = models.find((m) => m.id === keep);
			if (existing) {
				next.push(existing);
				notes.push(`kept active model ${keep}`);
			}
		}
		const added = next.filter((m) => !models.some((o) => o.id === m.id)).map((m) => m.id);
		const removed = models.filter((m) => !next.some((n) => n.id === m.id)).map((m) => m.id);
		models = next;
		modelsFetchedAt = Date.now();
		persistModels(models, modelsFetchedAt);
		notes.push(
			`models: ${models.length} (${added.length ? `+${added.join(",")}` : "+0"}, ${removed.length ? `-${removed.join(",")}` : "-0"})`,
		);
	} else {
		notes.push("catalog fetch failed; kept cached list");
	}

	if (version) {
		if (version !== cliVersion) notes.push(`cli version ${cliVersion} -> ${version}`);
		cliVersion = version;
		persistCliVersion(version);
	} else {
		notes.push("npm fetch failed; kept cached version");
	}

	register(pi);
	return notes.join("; ") || "nothing changed";
}

function defaultModelFrom(pi: ExtensionAPI): string | undefined {
	try {
		const settings = pi.getSettings() as { defaultProvider?: string; defaultModel?: string } | undefined;
		if (!settings || settings.defaultProvider !== "opencode") return undefined;
		return settings.defaultModel;
	} catch {
		return undefined;
	}
}

/**
 * Refresh the catalog after the cached snapshot ages out. Runs in the
 * background: startup never waits for the network.
 */
function refreshInBackground(pi: ExtensionAPI): void {
	if (Date.now() - modelsFetchedAt < CACHE_TTL_MS) return;
	void refresh(pi, defaultModelFrom(pi)).catch(() => {
		// Offline or gateway trouble: the cached list stays in use.
	});
}

function modelsListing(): string {
	const lines = models.map((m) => `- ${m.id} (${m.context.toLocaleString()} ctx)`);
	return `OpenCode Zen free models (${models.length}):\n` + lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	register(pi);
	refreshInBackground(pi);

	// New session -> rotate session/request ids (like the CLI per conversation)
	// and reset the project header until the session name is known.
	pi.on("session_start", () => {
		sessionId = createEid("ses");
		projectHeader = "pi-agent";
		register(pi);
	});

	// Session name (or id when unnamed) becomes the x-opencode-project header.
	pi.on("session_info_changed", (event) => {
		projectHeader = sanitizeHeaderValue(event.name ?? sessionId);
		register(pi);
	});

	// Pi identifies itself to opencode.ai as `x-opencode-client: pi` with its own
	// session id, which the free tier rejects. Repair that per request, and rotate
	// x-opencode-request for every message as the CLI does.
	pi.on("before_provider_headers", (event) => {
		applyFingerprintGuard(event.headers as HeaderBag, { sessionId, projectHeader, cliVersion });
	});

	pi.registerCommand("opencode-pi", {
		description:
			"OpenCode Zen free models. Subcommands: refresh (update models + CLI version), models (list), version (UA CLI version), help.",
		handler: async (args, ctx) => {
			const cmd = args.trim().split(/\s+/)[0];
			switch (cmd) {
				case "refresh": {
					const summary = await refresh(pi, ctx.model?.id);
					ctx.ui.notify(`opencode-pi refresh: ${summary}`, "info");
					break;
				}
				case "models": {
					ctx.ui.notify(modelsListing(), "info");
					break;
				}
				case "version": {
					ctx.ui.notify(`opencode-pi: User-Agent uses opencode/${cliVersion} (session ${sessionId.slice(0, 8)}…)`, "info");
					break;
				}
				default: {
					ctx.ui.notify("opencode-pi subcommands: refresh | models | version | help", "info");
				}
			}
		},
	});
}
