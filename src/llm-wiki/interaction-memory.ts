import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initLlmWiki } from "./init";
import { runWikiAgent, type AnorvisWikiResult } from "./agent";
import { llmWikiRoot } from "./paths";
import { slugify } from "./utils";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type InteractionMemoryInput = {
  sessionId?: string;
  turnIndex?: number;
  eventName?: string;
  prompt?: string;
  assistant?: JsonValue;
  toolResults?: JsonValue;
  interaction?: JsonValue;
  background?: boolean;
};

export type InteractionMemoryResult = {
  ok: true;
  rawPath: string;
  queued: boolean;
  wiki?: AnorvisWikiResult;
} | {
  ok: false;
  error: string;
};

type Deps = {
  rootDir?: string;
  now?: Date;
  wikiAgent?: NonNullable<Parameters<typeof runWikiAgent>[1]>["wikiAgent"];
  onBackgroundError?: (error: unknown) => void;
};

const MAX_FIELD_CHARS = 12_000;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|pk|rk)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_TOKEN]"],
  [/\b((?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*)[^\s,;\]}]+/gi, "$1[REDACTED]"],
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]"],
];
let compileQueue: Promise<unknown> = Promise.resolve();
const EMPTY_INTERACTION_ERROR = "prompt, assistant, or interaction is required";


export async function recordInteractionMemory(input: InteractionMemoryInput, deps: Deps = {}): Promise<InteractionMemoryResult> {
  const validationError = validateInteractionMemoryInput(input);
  if (validationError) return { ok: false, error: validationError };
  try {
    const rootDir = deps.rootDir ?? llmWikiRoot();
    const now = deps.now ?? new Date();
    initLlmWiki({ rootDir, now });

    const rawPath = writeRawInteraction(rootDir, now, input);
    const compile = () => compileInteractionMemory(input, rawPath, { ...deps, rootDir, now });

    if (input.background !== false) {
      compileQueue = compileQueue.then(compile, compile).catch((error) => deps.onBackgroundError?.(error));
      return { ok: true, rawPath, queued: true };
    }

    let wiki: AnorvisWikiResult | undefined;
    compileQueue = compileQueue.then(async () => { wiki = await compile(); }, async () => { wiki = await compile(); });
    await compileQueue;
    if (!wiki) throw new Error("Interaction memory compile did not return a result.");
    return { ok: true, rawPath, queued: false, wiki };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function validateInteractionMemoryInput(input: InteractionMemoryInput): string | undefined {
  if (typeof input.prompt === "string" && input.prompt.trim()) return undefined;
  if (hasMeaningfulJson(input.assistant)) return undefined;
  if (hasMeaningfulJson(input.interaction)) return undefined;
  return EMPTY_INTERACTION_ERROR;
}

function hasMeaningfulJson(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulJson);
  return Object.values(value).some(hasMeaningfulJson);
}

function writeRawInteraction(rootDir: string, now: Date, input: InteractionMemoryInput): string {
  const day = now.toISOString().slice(0, 10);
  const session = slugify(input.sessionId ?? "session").slice(0, 48) || "session";
  const turn = Number.isFinite(input.turnIndex) ? `turn-${input.turnIndex}` : "turn";
  const body = interactionMarkdown(input, now);
  const hash = createHash("sha256").update(body).digest("hex");
  const rawPath = `raw/sessions/${day}/${session}-${turn}-${hash.slice(0, 12)}.md`;
  const path = join(rootDir, rawPath);
  mkdirSync(join(rootDir, "raw", "sessions", day), { recursive: true });
  writeFileSync(path, `---\ntype: raw-source\nsourceId: ${hash}\nkind: interaction\ncaptured: ${now.toISOString()}\nhash: ${hash}\n---\n\n${body}`);
  return rawPath;
}

function interactionMarkdown(input: InteractionMemoryInput, now: Date): string {
  const parts = [
    "# Agent Interaction",
    "",
    `Captured: ${now.toISOString()}`,
    input.sessionId ? `Session: ${redact(input.sessionId)}` : undefined,
    typeof input.turnIndex === "number" ? `Turn: ${input.turnIndex}` : undefined,
    input.eventName ? `Event: ${redact(input.eventName)}` : undefined,
    "",
    "## User prompt",
    "",
    fenced(input.prompt ? redact(truncate(input.prompt, MAX_FIELD_CHARS)) : extractText(input.interaction, ["prompt", "input", "user", "content", "text"])),
    "",
    "## Assistant result",
    "",
    fenced(extractText(input.assistant, ["content", "text", "message"]) || summarizeUnknown(input.assistant)),
    "",
    "## Tool results",
    "",
    fenced(summarizeUnknown(input.toolResults)),
    "",
    "## Raw event excerpt",
    "",
    fenced(summarizeUnknown(input.interaction)),
    "",
  ].filter((part): part is string => part !== undefined);
  return `${parts.join("\n")}\n`;
}

async function compileInteractionMemory(input: InteractionMemoryInput, rawPath: string, deps: Required<Pick<Deps, "rootDir" | "now">> & Deps): Promise<AnorvisWikiResult> {
  const task = [
    "Process one completed Anorvis agent interaction into durable memory.",
    `Raw source: ${rawPath}`,
    input.prompt ? `User prompt: ${redact(truncate(input.prompt, 1_000))}` : undefined,
    "Read the raw source, then update existing wiki pages before creating new ones.",
    "Extract every durable fact worth remembering: preferences, project facts, decisions, workflows, goals, biographical details, dates, events, relationships, skills, opinions, plans, and user-tailoring guidance.",
    "Prefer many small dated claims over one summary sentence; a fact too minor for its own bullet is still worth a clause.",
    "Distinguish evidence levels: write directly stated facts plainly; prefix speculative or derived claims with `[inferred]`. Keep a provenance link either way so later verification can separate source from synthesis.",
    "File facts involving multiple people on every involved person's page, not only the speaker's.",
    "Route by scope per AGENTS.md: project-scoped detail stays in the project page; reusable cross-project decisions, repeatable workflows, and recurring entities get their own typed page under wiki/decisions/, wiki/workflows/, or wiki/entities/, wikilinked from related pages.",
    "Do not preserve secrets, credentials, one-off transcript detail, or private raw transcript in compiled wiki pages.",
    "If there is no durable memory, leave compiled pages unchanged and report unchanged.",
  ].filter(Boolean).join("\n");

  return runWikiAgent({ task }, { rootDir: deps.rootDir, now: deps.now, wikiAgent: deps.wikiAgent });
}

function extractText(value: unknown, keys: string[]): string {
  if (typeof value === "string") return redact(truncate(value, MAX_FIELD_CHARS));
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = row[key];
    if (typeof candidate === "string" && candidate.trim()) return redact(truncate(candidate, MAX_FIELD_CHARS));
  }
  return "";
}

function summarizeUnknown(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return redact(truncate(value, MAX_FIELD_CHARS));
  return redact(truncate(JSON.stringify(value, jsonReplacer, 2) ?? "", MAX_FIELD_CHARS));
}

function jsonReplacer(key: string, value: unknown): unknown {
  if (/api[_-]?key|token|secret|password|authorization/i.test(key)) return "[REDACTED]";
  return value;
}

function fenced(value: string): string {
  const content = value.trim() || "(none)";
  return `\`\`\`text\n${content.replaceAll("```", "`\u200b``")}\n\`\`\``;
}

function redact(value: string): string {
  return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`;
}

