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
 * Model list: only cost 0/0 and NOT deprecated. Refresh on demand with
 * `/opencode-pi refresh` (checks the catalog + latest CLI version from npm).
 * The validated list is cached in ~/.cache/opencode-pi/ and reused at load.
 */
const BASE_URL = "https://opencode.ai/zen/v1";
const CATALOG_URL = "https://models.opencode.ai/api.json";
const NPM_LATEST_URL = "https://registry.npmjs.org/opencode-ai/latest";

const CACHE_DIR = `${process.env.HOME}/.cache/opencode-pi`;
const MODELS_FILE = `${CACHE_DIR}/models.json`;
const VERSION_FILE = `${CACHE_DIR}/cli-version`;

const DEFAULT_CLI_VERSION = "1.18.25";

// opencode EID format, mirrored from packages/schema/src/identifier.ts:
// `<prefix>_<12 hex chars> + <14 random chars from a 62-char alphabet>`.
// The first 12 chars encode `Date.now() << 12 | counter`, the last 14 are
// random. The zen gateway rejects ids that do not match this structure with
// 403 FreeTierError, so we cannot send plain UUIDs anymore.
const EID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastEidTimestamp = 0;
let eidCounter = 0;

function createEid(prefix: "ses" | "msg"): string {
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

interface ModelSeed {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  context: number;
  output: number;
}

// Seed: non-deprecated free models from the catalog at build time.
const SEED_MODELS: ModelSeed[] = [
  {
    id: "nemotron-3.5-lightning-free",
    name: "Nemotron 3.5 Lightning Free",
    reasoning: true,
    input: ["text"], // text
    context: 262144,
    output: 262144,
  },
  {
    id: "nemotron-3-ultra-free",
    name: "Nemotron 3 Ultra Free",
    reasoning: true,
    input: ["text"], // text
    context: 1000000,
    output: 128000,
  },
  {
    id: "ling-3.0-flash-fin-free",
    name: "Ling 3.0 Flash Fin Free",
    reasoning: true,
    input: ["text"], // text
    context: 262144,
    output: 32768,
  },
  {
    id: "muse-spark-1.2-contributor-free",
    name: "Muse Spark 1.2 Free",
    reasoning: true,
    input: ["text", "image"], // text, image, video, pdf, audio
    context: 1048576,
    output: 131072,
  },
  {
    id: "mimo-v2.5-free",
    name: "MiMo V2.5 Free",
    reasoning: true,
    input: ["text", "image"], // text, image, audio, video
    context: 200000,
    output: 32000,
  },
  {
    id: "big-pickle",
    name: "Big Pickle",
    reasoning: true,
    input: ["text"], // text
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

function loadCliVersion(): string {
  return readCache(VERSION_FILE)?.trim() || DEFAULT_CLI_VERSION;
}

function loadModels(): ModelSeed[] {
  try {
    const raw = readCache(MODELS_FILE);
    if (!raw) return SEED_MODELS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : SEED_MODELS;
  } catch {
    return SEED_MODELS;
  }
}

function persistModels(list: ModelSeed[]): void {
  writeCache(MODELS_FILE, JSON.stringify(list, null, 2));
}

function persistCliVersion(version: string): void {
  writeCache(VERSION_FILE, version);
}

let cliVersion = loadCliVersion();
let models = loadModels();
let sessionId = createEid("ses");
let requestId = createEid("msg");
let projectHeader = "pi-agent";

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
      "x-opencode-request": requestId,
      "x-opencode-project": projectHeader,
    },
    models: providerModels(models),
  });
}

function stripProviderPrefix(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const parts = modelId.split("/");
  return parts[parts.length - 1];
}

/**
 * Fetch the catalog, keep cost-0 non-deprecated models, keep the currently
 * selected model if it would be dropped, update the CLI version from npm.
 * Returns a human-readable summary.
 */
async function refresh(pi: ExtensionAPI, keepModelId?: string): Promise<string> {
  const results = await Promise.allSettled([
    fetch(CATALOG_URL).then((r) => r.json() as Promise<Record<string, any>>),
    fetch(NPM_LATEST_URL).then((r) => r.json() as Promise<{ version?: string }>),
  ]);

  const notes: string[] = [];

  if (results[0].status === "fulfilled") {
    const catalog = results[0].value;
    const provider = catalog.opencode as { models?: Record<string, any> } | undefined;
    const next: ModelSeed[] = [];
    for (const entry of Object.values(provider?.models ?? {})) {
      const model = entry as Record<string, any>;
      const cost = (model.cost ?? {}) as Record<string, any>;
      const limit = (model.limit ?? {}) as Record<string, any>;
      const isFree = cost.input === 0 && cost.output === 0;
      const isDeprecated = model.status === "deprecated";
      if (!isFree || isDeprecated) continue;
      next.push({
        id: String(model.id ?? ""),
        name: String(model.name ?? model.id ?? "unknown"),
        reasoning: Boolean(model.reasoning),
        input: Array.isArray(model.modalities?.input) ? model.modalities.input.filter((x: unknown) => x === "text" || x === "image") : ["text"],
        context: limit.context ?? 200000,
        output: limit.output ?? 32768,
      });
    }
    // Never drop the model currently in use.
    const keep = stripProviderPrefix(keepModelId);
    if (keep && !next.some((m) => m.id === keep)) {
      const existing = models.find((m) => m.id === keep);
      if (existing) next.push(existing);
      notes.push(`kept active model ${keep}`);
    }
    const removed = models.filter((m) => !next.some((n) => n.id === m.id)).map((m) => m.id);
    const added = next.filter((m) => !models.some((o) => o.id === m.id)).map((m) => m.id);
    models = next;
    persistModels(models);
    notes.push(`models: ${models.length} (${added.length ? `+${added.join(",")}` : "+0"}, ${removed.length ? `-${removed.join(",")}` : "-0"})`);
  } else {
    notes.push("catalog fetch failed; kept cached list");
  }

  if (results[1].status === "fulfilled") {
    const version = results[1].value.version;
    if (typeof version === "string" && version) {
      if (version !== cliVersion) notes.push(`cli version ${cliVersion} -> ${version}`);
      cliVersion = version;
      persistCliVersion(version);
    }
  } else {
    notes.push("npm fetch failed; kept cached version");
  }

  register(pi);
  return notes.join("; ") || "nothing changed";
}

function modelsListing(): string {
  const lines = models.map((m) => `- ${m.id} (${m.context.toLocaleString()} ctx)`);
  return `OpenCode Zen free models (${models.length}):\n` + lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  register(pi);

  // New session -> rotate session/request ids (like the CLI per conversation)
  // and reset the project header until the session name is known.
  pi.on("session_start", () => {
    sessionId = createEid("ses");
    requestId = createEid("msg");
    projectHeader = "pi-agent";
    register(pi);
  });

  // Session name (or id when unnamed) becomes the x-opencode-project header.
  pi.on("session_info_changed", (event) => {
    projectHeader = event.name ?? sessionId;
    register(pi);
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
          ctx.ui.notify(
            "opencode-pi subcommands: refresh | models | version | help",
            "info",
          );
        }
      }
    },
  });
}
