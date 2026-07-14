import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Either, Effect, Schema } from "effect";
import { decodeUnknownResult } from "../../core/effect/schema";
import { json, parseJsonRequest, type JsonObject, type JsonValue } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import { initLlmWiki, lintLlmWiki, recordInteractionMemory, runWikiAgent, wikiResultAsJson, type InteractionMemoryInput } from "../../llm-wiki";
import { llmWikiRoot } from "../../llm-wiki/paths";
import { VaultRegistrationInvalid, VaultRegistryFailed, type VaultError } from "./errors";
import { VaultRegistrationInputSchema, VaultRegistrySchema, WikiAgentRequestSchema, type VaultEntry } from "./schema";

const OptionalJsonObjectTextSchema = Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown }));
const VaultRegistryTextSchema = Schema.parseJson(VaultRegistrySchema);

export type LlmWikiRouteOptions = {
  wikiAgent?: NonNullable<Parameters<typeof runWikiAgent>[1]>["wikiAgent"];
};

type InteractionMemoryParseResult = {
  ok: true;
  input: InteractionMemoryInput;
} | {
  ok: false;
  error: string;
};

export function llmWikiRoutes(options: LlmWikiRouteOptions): RouteRegistrar {
  return (route) => {
    route.post("/v1/llm-wiki/init", () => json(initLlmWiki()));

    route.get("/v1/llm-wiki/vaults", () => json(Effect.runSync(readVaultRegistryEffect())));

    route.post("/v1/llm-wiki/vaults", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = decodeUnknownResult(VaultRegistrationInputSchema, parsed.value);
      if (!input.ok) return json({ error: input.error.message }, 400);
      const result = Effect.runSync(Effect.either(addVaultEffect(input.value)));
      return Either.isRight(result) ? json(result.right, 201) : vaultErrorResponse(result.left);
    });

    route.post("/v1/llm-wiki/wiki", async (c) => {
      const input = decodeUnknownResult(WikiAgentRequestSchema, await readOptionalJsonObject(c.req.raw));
      if (!input.ok) return json({ error: input.error.message }, 400);
      const task = input.value.task?.trim() ? input.value.task : "Orient the Anorvis LLM Wiki.";
      const vault = input.value.vault?.trim() ? input.value.vault : undefined;
      const result = await runWikiAgent({ task, allowWeb: input.value.allowWeb === true, dryRun: input.value.dryRun === true, vault, timeoutMs: input.value.timeoutMs }, { wikiAgent: options.wikiAgent });
      return json(wikiResultAsJson(result));
    });

    route.post("/v1/llm-wiki/interaction", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseInteractionMemoryRequest(parsed.value);
      if (!input.ok) return json({ error: input.error }, 400);
      const result = await recordInteractionMemory(input.input, { wikiAgent: options.wikiAgent });
      return json(result);
    });

    route.get("/v1/llm-wiki/lint", async () => json(await lintLlmWiki()));
  };
}

async function readOptionalJsonObject(request: Request): Promise<JsonObject> {
  const text = await request.text();
  if (!text.trim()) return {};
  const decoded = decodeUnknownResult(OptionalJsonObjectTextSchema, text);
  return decoded.ok ? decoded.value as JsonObject : {};
}

function readVaultRegistryEffect(): Effect.Effect<{ vaults: VaultEntry[] }, never> {
  return Effect.sync(readVaultRegistry);
}

function addVaultEffect(value: { name?: string; path: string }): Effect.Effect<{ vaults: VaultEntry[]; vault: VaultEntry }, VaultError> {
  return Effect.try({
    try: () => addVault(value),
    catch: (error) => error instanceof VaultRegistrationInvalid || error instanceof VaultRegistryFailed
      ? error
      : new VaultRegistryFailed({ message: error instanceof Error ? error.message : String(error) }),
  });
}

function vaultErrorResponse(error: VaultError): Response {
  if (error instanceof VaultRegistrationInvalid) return json({ error: error.message }, 400);
  return json({ error: error.message }, 500);
}

function readVaultRegistry(): { vaults: VaultEntry[] } {
  try {
    const decoded = decodeUnknownResult(VaultRegistryTextSchema, readFileSync(vaultRegistryPath(), "utf8"));
    return { vaults: decoded.ok ? [...decoded.value.vaults] : [] };
  } catch {
    return { vaults: [] };
  }
}

function addVault(value: { name?: string; path: string }): { vaults: VaultEntry[]; vault: VaultEntry } {
  const real = safeRealpath(value.path.trim());
  if (!real) throw new VaultRegistrationInvalid({ message: "path is required" });
  if (!pathIsDirectory(real) || !pathIsDirectory(join(real, ".obsidian"))) throw new VaultRegistrationInvalid({ message: "vault must contain .obsidian" });
  const registry = readVaultRegistry();
  const existingRealpaths = new Set(registry.vaults.map((vault) => safeRealpath(vault.path)).filter((path): path is string => Boolean(path)));
  if (existingRealpaths.has(real)) throw new VaultRegistrationInvalid({ message: "vault already registered" });
  const vault = {
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : real.split(/[\\/]/).at(-1) ?? "Vault",
    path: real,
    addedAt: new Date().toISOString(),
  };
  const vaults = [...registry.vaults, vault].sort((a, b) => a.name.localeCompare(b.name));
  const path = vaultRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ vaults }, null, 2)}\n`);
  return { vaults, vault };
}

function vaultRegistryPath(): string {
  return join(llmWikiRoot(), ".index", "vaults.json");
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function pathIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function parseInteractionMemoryRequest(value: JsonValue): InteractionMemoryParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "JSON object body is required" };

  const input: InteractionMemoryInput = {
    background: value.background !== false,
  };
  if (value.compile === false) input.compile = false;
  if (typeof value.sessionId === "string" && value.sessionId.trim()) input.sessionId = value.sessionId;
  if (typeof value.turnIndex === "number" && Number.isInteger(value.turnIndex)) input.turnIndex = value.turnIndex;
  if (typeof value.eventName === "string" && value.eventName.trim()) input.eventName = value.eventName;
  if (typeof value.prompt === "string" && value.prompt.trim()) input.prompt = value.prompt;
  if ("assistant" in value) input.assistant = value.assistant;
  if ("toolResults" in value) input.toolResults = value.toolResults;
  if ("interaction" in value) input.interaction = value.interaction;

  return hasInteractionMemoryContent(input)
    ? { ok: true, input }
    : { ok: false, error: "prompt, assistant, or interaction is required" };
}

function hasInteractionMemoryContent(input: InteractionMemoryInput): boolean {
  return Boolean(input.prompt?.trim()) || hasMeaningfulJson(input.assistant) || hasMeaningfulJson(input.interaction);
}

function hasMeaningfulJson(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulJson);
  return Object.values(value).some(hasMeaningfulJson);
}
