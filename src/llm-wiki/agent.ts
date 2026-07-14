import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Schema } from "effect";
import { decodeUnknownResult } from "../core/effect/schema";
import { resolveAgentModel, resolveAgentThinking } from "../core/config/agent-settings";
import { runAgentProcess } from "../core/agent/process";
import { getHomeDir } from "../paths";
import { initLlmWiki } from "./init";
import { rebuildManifest } from "./manifest";
import { llmWikiRoot } from "./paths";
import { applyDeterministicLintFixes, lintLlmWiki, type WikiLintIssue } from "./lint";
import { isInside, listMarkdownFiles, slugify, titleFromMarkdown } from "./utils";

export type AnorvisWikiInput = {
  task: string;
  allowWeb?: boolean;
  dryRun?: boolean;
  vault?: string;
  timeoutMs?: number;
};

export type AnorvisWikiResult = {
  task: string;
  answer: string;
  confidence: "high" | "medium" | "low";
  sources: Array<{ path: string; sourceId?: string; title?: string; origin?: string; hash?: string }>;
  changed: Array<{ path: string; action: "created" | "updated" | "unchanged"; why: string }>;
  readNext: Array<{ path: string; reason: string }>;
  contradictions: string[];
  gaps: string[];
  warnings: string[];
};

const AgentJsonTextSchema = Schema.parseJson(Schema.Unknown);
const VaultRegistryTextSchema = Schema.parseJson(
  Schema.Struct({
    vaults: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          path: Schema.String,
          addedAt: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
);

type VaultRef = { name: string; path: string };
type WikiAgentRun = { task: string; rootDir: string; now: Date; allowWeb?: boolean; dryRun?: boolean; vault?: VaultRef; timeoutMs?: number };
type WikiAgentRunner = (input: WikiAgentRun) => Promise<AnorvisWikiResult>;
type Deps = { rootDir?: string; now?: Date; legacyRoot?: string; wikiAgent?: WikiAgentRunner };

export async function runWikiAgent(input: AnorvisWikiInput, deps: Deps = {}): Promise<AnorvisWikiResult> {
  const rootDir = deps.rootDir ?? llmWikiRoot();
  const now = deps.now ?? new Date();
  initLlmWiki({ rootDir, now });

  const first = input.task.toLowerCase().includes("migrat")
    ? runMigration(input, { rootDir, now, legacyRoot: deps.legacyRoot })
    : await (deps.wikiAgent ?? runCliWikiAgent)({ task: input.task, rootDir, now, allowWeb: input.allowWeb, dryRun: input.dryRun, vault: input.vault ? resolveVault(rootDir, input.vault) : undefined, timeoutMs: input.timeoutMs });
  if (input.dryRun) return first;

  let result = first;
  let lint = await lintLlmWiki({ rootDir });
  let attempts = 0;
  while (!lint.ok && attempts < 3) {
    attempts += 1;
    applyDeterministicLintFixes({ rootDir });
    repairGeneratedPages(rootDir, now, lint.issues);
    lint = await lintLlmWiki({ rootDir });
  }
  updateIndex(rootDir, now);
  rebuildManifest(rootDir, now);
  if (result.changed.length) appendLog(rootDir, now, "wiki", `Wiki Agent handled ${input.task.slice(0, 80)}`);
  if (!lint.ok) {
    result = { ...result, confidence: "low", warnings: [...result.warnings, `Wiki lint still has ${lint.issues.length} issue(s).`, ...lint.issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`)] };
  }
  return result;
}

async function runCliWikiAgent(input: WikiAgentRun): Promise<AnorvisWikiResult> {
  const prompt = wikiAgentPrompt(input);
  const tools = input.vault || input.dryRun ? "read,grep,find,ls" : "read,grep,find,ls,write,edit";
  const args = ["--print", "--no-extensions", "--no-skills", "--tools", tools, "--name", "Anorvis Wiki Agent"];
  const model = resolveAgentModel("wiki");
  if (model) args.push("--model", model);
  const thinking = resolveAgentThinking("wiki");
  if (thinking) args.push("--thinking", thinking);
  args.push(prompt);

  const agent = resolveWikiAgentCommand();
  const timeoutMs = wikiAgentTimeoutMs(input.timeoutMs);
  const run = await runAgentProcess({
    command: agent.command,
    args,
    cwd: input.vault?.path ?? input.rootDir,
    label: agent.label,
    timeoutMs,
  });
  const { stdout, stderr, code, timedOut, cancelled, outputLimited } = run;
  const parsed =
    !timedOut && !cancelled && !outputLimited
      ? parseAgentJson(stdout)
      : undefined;
  if (parsed)
    return normalizeResult(
      input.task,
      parsed,
      stderr.trim() ? [`${agent.label} stderr: ${stderr.trim().slice(0, 500)}`] : [],
    );
  if (timedOut) {
    const seconds = Math.round(timeoutMs / 1000);
    return {
      task: input.task,
      answer: `${agent.label} timed out after ${seconds}s before reporting a result. Any file changes it made were still applied; check log.md and recently modified pages to verify.`,
      confidence: "low",
      sources: [],
      changed: [],
      readNext: [],
      contradictions: [],
      gaps: [`${agent.label} run is unverified: it hit the ${seconds}s timeout before returning JSON. Pass a larger timeoutMs for long tasks.`],
      warnings: [`${agent.label} did not return parseable JSON.`, ...(stderr.trim() ? [stderr.trim().slice(0, 1000)] : [])],
    };
  }
  if (outputLimited || cancelled) {
    const reason = outputLimited ? "exceeded the output limit" : "was cancelled";
    return {
      task: input.task,
      answer: `${agent.label} ${reason} before reporting a verified result.`,
      confidence: "low",
      sources: [],
      changed: [],
      readNext: [],
      contradictions: [],
      gaps: [`${agent.label} run is unverified because it ${reason}.`],
      warnings: [
        `${agent.label} did not return parseable JSON.`,
        ...(stderr.trim() ? [stderr.trim().slice(0, 1_000)] : []),
      ],
    };
  }
  return {
    task: input.task,
    answer: stdout.trim() || `${agent.label} failed with exit code ${code}.`,
    confidence: code === 0 ? "medium" : "low",
    sources: [],
    changed: [],
    readNext: [],
    contradictions: [],
    gaps: code === 0 ? [] : [`${agent.label} exited with code ${code}.`],
    warnings: [`${agent.label} did not return parseable JSON.`, ...(stderr.trim() ? [stderr.trim().slice(0, 1000)] : [])],
  };
}

const DEFAULT_WIKI_AGENT_TIMEOUT_MS = 300_000;
const MAX_WIKI_AGENT_TIMEOUT_MS = 3_600_000;

function wikiAgentTimeoutMs(requested?: number): number {
  const env = Number(process.env.ANORVIS_WIKI_AGENT_TIMEOUT_MS);
  const candidate = requested ?? (Number.isFinite(env) ? env : undefined) ?? DEFAULT_WIKI_AGENT_TIMEOUT_MS;
  return Number.isFinite(candidate) && candidate > 0 ? Math.min(candidate, MAX_WIKI_AGENT_TIMEOUT_MS) : DEFAULT_WIKI_AGENT_TIMEOUT_MS;
}

function wikiAgentPrompt(input: WikiAgentRun): string {
  const scope = input.vault ? `Obsidian vault root: ${input.vault.path}\nVault name: ${input.vault.name}` : `LLM Wiki root: ${input.rootDir}`;
  const mode = input.vault
    ? "You are running inside one selected Obsidian vault. Stay within this vault. Use read/find/grep/ls only. Do not write to the vault or inspect other vaults."
    : "You are running inside the Anorvis LLM Wiki root. You may update raw/ and wiki/ for capture/update tasks.";
  return `You are the Anorvis Wiki Agent.

Task: ${input.task}
Date: ${input.now.toISOString().slice(0, 10)}
Allow web: ${input.allowWeb === true}
Dry run: ${input.dryRun === true}
${scope}

Rules:
- ${mode}
- Use only the built-in file tools available to you. Do not rely on precomputed keyword search or prior chat memory.
- For LLM Wiki mode: first inspect AGENTS.md, index.md, cache.md, .index/vaults.json if present, and relevant files under wiki/ and raw/ using read/find/grep/ls as needed.
- For vault mode: inspect only the selected vault with read/find/grep/ls and cite vault-relative paths you inspected.
- For recall/question tasks: answer only from files you inspected.
- For remember/store/capture/update tasks in LLM Wiki mode: create/update raw source and compiled wiki pages, then cite changed paths.
- Never store secrets.
- Return ONLY valid JSON with this exact shape:
{"task":"...","answer":"...","confidence":"high|medium|low","sources":[{"path":"...","title":"..."}],"changed":[{"path":"...","action":"created|updated|unchanged","why":"..."}],"readNext":[{"path":"...","reason":"..."}],"contradictions":[],"gaps":[],"warnings":[]}`;
}

function resolveVault(rootDir: string, query: string): VaultRef {
  const vaultsPath = join(rootDir, ".index", "vaults.json");
  const decoded = decodeUnknownResult(VaultRegistryTextSchema, readFileSync(vaultsPath, "utf8"));
  const vaults = decoded.ok ? decoded.value.vaults ?? [] : [];
  const normalizedQuery = query.toLowerCase();
  const queryPath = safeRealpath(query);
  const vault = vaults.find((item) => item.name.toLowerCase() === normalizedQuery || item.path === query || (queryPath && safeRealpath(item.path) === queryPath));
  if (!vault) throw new Error(`Vault is not added to Anorvis: ${query}`);
  const real = safeRealpath(vault.path);
  if (!real) throw new Error(`Added vault is not readable: ${vault.path}`);
  return { name: vault.name, path: real };
}

function safeRealpath(path: string): string | undefined {
  try { return realpathSync(path); } catch { return undefined; }
}

type AgentCommand = { command: string; label: string };

export function resolveWikiAgentCommand(env: Record<string, string | undefined> = process.env, commandAvailable: (command: string) => boolean = commandExists): AgentCommand {
  const explicit = env.ANORVIS_AGENT_COMMAND;
  if (explicit) return { command: explicit, label: `${explicit} Wiki Agent` };

  const explicitOmp = env.ANORVIS_OMP_COMMAND;
  if (explicitOmp) return { command: explicitOmp, label: `${explicitOmp} Wiki Agent` };

  const explicitPi = env.ANORVIS_PI_COMMAND;
  if (explicitPi) return { command: explicitPi, label: `${explicitPi} Wiki Agent` };

  if (commandAvailable("pi")) return { command: "pi", label: "Pi Wiki Agent" };
  if (commandAvailable("omp")) return { command: "omp", label: "OMP Wiki Agent" };
  return { command: "pi", label: "Pi Wiki Agent" };
}

function commandExists(command: string): boolean {
  const shell = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  return spawnSync(shell, args, { stdio: "ignore", shell: process.platform !== "win32" }).status === 0;
}


function parseAgentJson(stdout: string): unknown {
  const decoded = decodeUnknownResult(AgentJsonTextSchema, stdout);
  if (decoded.ok) return decoded.value;
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  const sliced = decodeUnknownResult(AgentJsonTextSchema, stdout.slice(start, end + 1));
  return sliced.ok ? sliced.value : undefined;
}

function normalizeResult(task: string, value: unknown, warnings: string[]): AnorvisWikiResult {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    task,
    answer: typeof obj.answer === "string" ? obj.answer : "Anorvis Wiki Agent completed without an answer.",
    confidence: obj.confidence === "high" || obj.confidence === "medium" || obj.confidence === "low" ? obj.confidence : "medium",
    sources: normalizeSources(obj.sources),
    changed: normalizeChanged(obj.changed),
    readNext: normalizeReadNext(obj.readNext),
    contradictions: stringArray(obj.contradictions),
    gaps: stringArray(obj.gaps),
    warnings: [...stringArray(obj.warnings), ...warnings],
  };
}

function normalizeSources(value: unknown): AnorvisWikiResult["sources"] {
  return Array.isArray(value) ? value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    return typeof row.path === "string" ? [{ path: row.path, title: typeof row.title === "string" ? row.title : undefined }] : [];
  }) : [];
}

function normalizeChanged(value: unknown): AnorvisWikiResult["changed"] {
  return Array.isArray(value) ? value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const action = row.action === "created" || row.action === "updated" || row.action === "unchanged" ? row.action : "updated";
    return typeof row.path === "string" ? [{ path: row.path, action, why: typeof row.why === "string" ? row.why : "Reported by Anorvis Wiki Agent." }] : [];
  }) : [];
}

function normalizeReadNext(value: unknown): AnorvisWikiResult["readNext"] {
  return Array.isArray(value) ? value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    return typeof row.path === "string" ? [{ path: row.path, reason: typeof row.reason === "string" ? row.reason : "Suggested by Anorvis Wiki Agent." }] : [];
  }) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function runMigration(input: AnorvisWikiInput, deps: { rootDir: string; now: Date; legacyRoot?: string }): AnorvisWikiResult {
  const legacyRoot = deps.legacyRoot ?? join(getHomeDir(), ".anorvis", "memory");
  const files = existsSync(legacyRoot) ? listLegacyFiles(legacyRoot).slice(0, 200) : [];
  if (input.dryRun) {
    return {
      task: input.task,
      answer: `Dry run: found ${files.length} legacy memory file(s) to migrate from ${legacyRoot}.`,
      confidence: files.length ? "high" : "low",
      sources: [],
      changed: [],
      readNext: files.slice(0, 10).map((path) => ({ path, reason: "Legacy source candidate." })),
      contradictions: [],
      gaps: files.length ? [] : ["No legacy memory files found."],
      warnings: ["Dry run only; no files were written."],
    };
  }

  const changed: AnorvisWikiResult["changed"] = [];
  const sources: AnorvisWikiResult["sources"] = [];
  for (const abs of files) {
    const rel = relative(legacyRoot, abs);
    const body = readFileSync(abs, "utf8");
    const raw = writeRawSource(deps.rootDir, { kind: "note", origin: `legacy-memory:${rel}`, title: rel, body, now: deps.now });
    sources.push(raw);
    changed.push({ path: raw.path, action: "created", why: `Copied legacy memory ${rel} as raw source.` });
  }

  const today = deps.now.toISOString().slice(0, 10);
  const pagePath = "wiki/sources/legacy-memory-migration.md";
  const page = `---
type: source
title: "Legacy Memory Migration"
created: ${today}
updated: ${today}
status: developing
tags: []
related: []
sources: [${sources.map((s) => s.path).join(", ")}]
---

# Legacy Memory Migration

Migrated ${sources.length} legacy Anorvis memory file(s) into LLM Wiki raw sources.

## Migrated sources

${sources.map((s) => `- ${s.path}${s.sourceId ? ` (src: ${s.sourceId})` : ""}`).join("\n")}
`;
  writeFile(deps.rootDir, pagePath, page);
  changed.push({ path: pagePath, action: "created", why: "Compiled migration overview page." });
  updateIndex(deps.rootDir, deps.now);
  appendLog(deps.rootDir, deps.now, "migrate", `Migrated ${sources.length} legacy memory file(s)`);
  rebuildManifest(deps.rootDir, deps.now);
  changed.push({ path: "index.md", action: "updated", why: "Refreshed index." }, { path: "log.md", action: "updated", why: "Logged migration." }, { path: ".index/manifest.json", action: "updated", why: "Rebuilt manifest." });

  return {
    task: input.task,
    answer: `Migrated ${sources.length} legacy memory file(s) into ${pagePath}. Verify the LLM Wiki, then explicitly delete legacy memory if desired.`,
    confidence: "medium",
    sources,
    changed,
    readNext: [{ path: pagePath, reason: "Review migration result before cleanup." }],
    contradictions: [],
    gaps: [],
    warnings: ["Legacy memory was not deleted. Cleanup is explicit after verification."],
  };
}

function writeRawSource(rootDir: string, input: { kind: "note" | "web" | "email" | "file" | "vault" | "session"; origin: string; title: string; body: string; now: Date }) {
  const hash = createHash("sha256").update(input.body).digest("hex");
  const short = hash.slice(0, 8);
  const day = input.now.toISOString().slice(0, 10);
  const sourceId = `src-${day.replaceAll("-", "")}-${short}`;
  const path = `raw/${rawKindDir(input.kind)}/${day}-${slugify(input.title)}-${short}.md`;
  const content = `---
type: raw-source
sourceId: "${sourceId}"
kind: ${input.kind}
origin: "${escapeYaml(input.origin)}"
title: "${escapeYaml(input.title)}"
captured: ${input.now.toISOString()}
hash: "sha256:${hash}"
---

${input.body}
`;
  writeFile(rootDir, path, content);
  return { path, sourceId, title: input.title, origin: input.origin, hash: `sha256:${hash}` };
}

function rawKindDir(kind: "note" | "web" | "email" | "file" | "vault" | "session"): string {
  return ({ note: "notes", web: "web", email: "email", file: "files", vault: "vaults", session: "sessions" })[kind];
}

function updateIndex(rootDir: string, now: Date): void {
  const pages = listMarkdownFiles(rootDir, "wiki");
  const groups = new Map<string, string[]>();
  for (const page of pages) {
    const top = page.split("/")[1] ?? "Other";
    const title = titleFromMarkdown(readFileSync(join(rootDir, page), "utf8"), page);
    groups.set(top, [...groups.get(top) ?? [], `- [${title}](${page})`]);
  }
  const body = [`# Anorvis LLM Wiki Index`, ``, `> Catalog of compiled Anorvis wiki pages.`, `> Last updated: ${now.toISOString().slice(0, 10)}`, ``];
  for (const [group, items] of [...groups.entries()].sort()) body.push(`## ${capitalize(group)}`, ``, ...items.sort(), ``);
  writeFileSync(join(rootDir, "index.md"), `${body.join("\n").trim()}\n`);
}

function appendLog(rootDir: string, now: Date, action: string, subject: string): void {
  const path = join(rootDir, "log.md");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "# Anorvis LLM Wiki Log\n";
  writeFileSync(path, `${existing.trim()}\n\n## [${now.toISOString().slice(0, 10)}] ${action} | ${subject}\n- ${now.toISOString()}\n`);
}

function writeFile(rootDir: string, relPath: string, content: string): void {
  const abs = resolve(rootDir, relPath);
  if (!isInside(rootDir, abs)) throw new Error(`Refusing to write outside LLM Wiki: ${relPath}`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function listLegacyFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    try {
      const stat = Bun.file(abs);
      if (name.startsWith(".")) continue;
      if (existsSync(abs) && readdirOrNull(abs)) out.push(...listLegacyFiles(abs));
      else if (name.endsWith(".md")) out.push(abs);
      void stat;
    } catch {
      // ignore unreadable legacy paths
    }
  }
  return out;
}

function readdirOrNull(path: string): string[] | null {
  try { return readdirSync(path); } catch { return null; }
}

function repairGeneratedPages(rootDir: string, now: Date, issues: WikiLintIssue[]): void {
  void issues;
  updateIndex(rootDir, now);
  rebuildManifest(rootDir, now);
}

function escapeYaml(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, " ");
}

function capitalize(input: string): string {
  return input.slice(0, 1).toUpperCase() + input.slice(1);
}

export function wikiResultAsJson(result: AnorvisWikiResult): Record<string, unknown> {
  return result;
}
