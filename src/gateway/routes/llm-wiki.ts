import { initLlmWiki, lintLlmWiki, recordInteractionMemory, runWikiAgent, wikiResultAsJson, type InteractionMemoryInput } from "../../llm-wiki";
import { isJsonObject, json, parseJsonRequest, type JsonValue, type RouteHandler } from "../http";

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

export function llmWikiRoutes(options: LlmWikiRouteOptions): RouteHandler {
  return async (request, url) => {
    if (request.method === "POST" && url.pathname === "/v1/llm-wiki/init") return json(initLlmWiki());
    if (request.method === "POST" && url.pathname === "/v1/llm-wiki/wiki") {
      const body = await request.text().then((text) => JSON.parse(text) as unknown).catch(() => ({}));
      const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const task = typeof input.task === "string" && input.task.trim() ? input.task : "Orient the Anorvis LLM Wiki.";
      const vault = typeof input.vault === "string" && input.vault.trim() ? input.vault : undefined;
      const result = await runWikiAgent({ task, allowWeb: input.allowWeb === true, dryRun: input.dryRun === true, vault }, { wikiAgent: options.wikiAgent });
      return json(wikiResultAsJson(result));
    }
    if (request.method === "POST" && url.pathname === "/v1/llm-wiki/interaction") {
      const parsed = await parseJsonRequest(request);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const interactionInput = parseInteractionMemoryRequest(parsed.value);
      if (!interactionInput.ok) return json({ error: interactionInput.error }, 400);
      const result = await recordInteractionMemory(interactionInput.input, { wikiAgent: options.wikiAgent });
      return json(result);
    }
    if (request.method === "GET" && url.pathname === "/v1/llm-wiki/lint") return json(await lintLlmWiki());
    return undefined;
  };
}

function parseInteractionMemoryRequest(value: JsonValue): InteractionMemoryParseResult {
  if (!isJsonObject(value)) return { ok: false, error: "JSON object body is required" };

  const input: InteractionMemoryInput = {
    background: value.background !== false,
  };
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
