"use node";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
export type RecipeInput = {
  title: string; source: "url"; sourceId?: string; sourceUrl?: string; imageUrl?: string;
  youtubeUrl?: string; category?: string; area?: string; calories: number; proteinGrams: number;
  carbsGrams: number; fatGrams: number; favorite: boolean; notes?: string;
  ingredients: Array<{ name: string; quantity?: string }>; instructions: string[];
};

function parseRecipeInput(value: Record<string, unknown>): RecipeInput | null {
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (!title) return null;
  const optional = (input: unknown) => typeof input === "string" && input.trim() ? input.trim() : undefined;
  const ingredients = Array.isArray(value.ingredients)
    ? value.ingredients.flatMap((item) => {
        if (!isRecord(item)) return [];
        const name = optional(item.name);
        return name ? [{ name, quantity: optional(item.quantity) }] : [];
      })
    : [];
  return {
    title, source: "url", sourceId: optional(value.sourceId), sourceUrl: optional(value.sourceUrl),
    imageUrl: optional(value.imageUrl), youtubeUrl: optional(value.youtubeUrl), category: optional(value.category),
    area: optional(value.area), calories: Number(value.calories) || 0, proteinGrams: Number(value.proteinGrams) || 0,
    carbsGrams: Number(value.carbsGrams) || 0, fatGrams: Number(value.fatGrams) || 0, favorite: false,
    notes: optional(value.notes), ingredients,
    instructions: Array.isArray(value.instructions) ? value.instructions.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [],
  };
}


// --- Bounds (all net-new; this is the first user-controlled outbound fetch) ---
const MAX_URL_LENGTH = 2048;
const FETCH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB
const MAX_REDIRECTS = 3;
const MAX_JSONLD_BLOCKS = 20;
const MAX_JSONLD_BYTES = 256 * 1024;
const MAX_GRAPH_NODES = 5000;
const MAX_INGREDIENTS = 100;
const MAX_INSTRUCTIONS = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_INSTRUCTION_DEPTH = 6;

const USER_AGENT = "AnorvisRecipeImporter/1.0 (+https://anorvis.local)";
const ACCEPT_HEADER = "text/html,application/xhtml+xml,application/ld+json";
const REDIRECT_STATUSES: Record<number, true> = {
  301: true,
  302: true,
  303: true,
  307: true,
  308: true,
};

export type ImportErrorKind = "invalid_url" | "blocked_url" | "no_recipe" | "upstream";

export class RecipeImportError extends Error {
  readonly kind: ImportErrorKind;
  constructor(kind: ImportErrorKind, message: string) {
    super(message);
    this.name = "RecipeImportError";
    this.kind = kind;
  }
}

export type FetchedPage = { html: string; finalUrl: string };
export type FetchHtml = (url: string) => Promise<FetchedPage>;
export type ImportRecipeDeps = { fetchHtml: FetchHtml };

export type JsonLdExtraction = {
  blocks: unknown[];
  scriptCount: number;
  parseFailures: number;
};

// ---------------------------------------------------------------------------
// Public entry point (injectable fetcher mirrors the now=new Date() seam).
// ---------------------------------------------------------------------------
export async function importRecipeFromUrl(
  rawUrl: string,
  deps: ImportRecipeDeps = { fetchHtml: safeFetchHtml },
): Promise<RecipeInput> {
  // Reject invalid/blocked URLs before any outbound work happens.
  const requested = assertPublicHttpUrl(rawUrl);
  const page = await deps.fetchHtml(requested.toString());
  const canonical = canonicalizeUrl(safeParseUrl(page.finalUrl) ?? requested);
  const extraction = extractJsonLd(page.html);
  const recipeNode = findSchemaRecipe(extraction.blocks);
  if (!recipeNode) {
    // JSON-LD was advertised but every block failed to parse -> upstream parse
    // failure (distinct from a well-formed page that simply has no Recipe).
    if (extraction.scriptCount > 0 && extraction.blocks.length === 0) {
      throw new RecipeImportError(
        "upstream",
        "recipe metadata at url could not be parsed",
      );
    }
    throw new RecipeImportError(
      "no_recipe",
      "no schema.org Recipe found at url",
    );
  }
  const normalized = normalizeSchemaRecipe(recipeNode, canonical);
  const input = parseRecipeInput(normalized);
  if (!input) {
    throw new RecipeImportError(
      "no_recipe",
      "recipe at url was missing a usable title",
    );
  }
  return input;
}

export function describeImportError(error: unknown): {
  status: number;
  message: string;
} {
  if (error instanceof RecipeImportError) {
    const status =
      error.kind === "no_recipe" ? 422 : error.kind === "upstream" ? 502 : 400;
    return { status, message: error.message };
  }
  // Any unexpected failure is treated as an upstream/parse failure.
  return { status: 502, message: "failed to import recipe" };
}

// ---------------------------------------------------------------------------
// URL guard (synchronous scheme/host checks; DNS validation happens per-hop).
// ---------------------------------------------------------------------------
export function assertPublicHttpUrl(rawUrl: unknown): URL {
  if (typeof rawUrl !== "string") {
    throw new RecipeImportError("invalid_url", "recipe url is required");
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new RecipeImportError("invalid_url", "recipe url is required");
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new RecipeImportError("invalid_url", "recipe url is too long");
  }
  const url = safeParseUrl(trimmed);
  if (!url) {
    throw new RecipeImportError("invalid_url", "recipe url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RecipeImportError(
      "invalid_url",
      "recipe url must use http or https",
    );
  }
  assertPublicHost(url.hostname);
  return url;
}

function assertPublicHost(hostname: string): void {
  const host = hostname.toLowerCase();
  if (!host) {
    throw new RecipeImportError("blocked_url", "recipe url host is empty");
  }
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // Bare IP literals are never a legitimate recipe host and open the door to
  // alternate encodings, so reject the whole category (the contract lists
  // "IP literals"). DNS names are validated against resolved addresses later.
  if (isIP(bare) !== 0) {
    throw new RecipeImportError(
      "blocked_url",
      "recipe url host must be a public hostname",
    );
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new RecipeImportError(
      "blocked_url",
      "recipe url host is not a public address",
    );
  }
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) {
    throw new RecipeImportError(
      "blocked_url",
      "recipe url host is not a public address",
    );
  }
}

// ---------------------------------------------------------------------------
// SSRF-hardened fetch: DNS validation per hop, manual redirects, size/type caps.
// ---------------------------------------------------------------------------
export async function safeFetchHtml(rawUrl: string): Promise<FetchedPage> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let target = assertPublicHttpUrl(rawUrl);
  for (let redirects = 0; ; redirects += 1) {
    if (redirects > MAX_REDIRECTS) {
      throw new RecipeImportError(
        "upstream",
        "too many redirects while importing recipe",
      );
    }
    await assertResolvesPublic(target.hostname);
    const response = await fetchOnce(target, signal);
    if (REDIRECT_STATUSES[response.status]) {
      await cancelBody(response);
      const location = response.headers.get("location");
      if (!location) {
        throw new RecipeImportError(
          "upstream",
          "recipe url redirect was missing a location",
        );
      }
      const next = safeParseUrl(location, target);
      if (!next) {
        throw new RecipeImportError(
          "upstream",
          "recipe url redirect target was invalid",
        );
      }
      // Re-validate scheme/host of every hop before following.
      target = assertPublicHttpUrl(next.toString());
      continue;
    }
    return readCappedHtml(response, target.toString());
  }
}

async function assertResolvesPublic(hostname: string): Promise<void> {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  if (isIP(bare) !== 0) {
    if (isBlockedIp(bare)) {
      throw new RecipeImportError(
        "blocked_url",
        "recipe url host is not a public address",
      );
    }
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new RecipeImportError(
      "upstream",
      "recipe url host could not be resolved",
    );
  }
  if (records.length === 0) {
    throw new RecipeImportError(
      "upstream",
      "recipe url host could not be resolved",
    );
  }
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new RecipeImportError(
        "blocked_url",
        "recipe url resolves to a non-public address",
      );
    }
  }
}

async function fetchOnce(url: URL, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { accept: ACCEPT_HEADER, "user-agent": USER_AGENT },
    });
  } catch (error) {
    throw new RecipeImportError(
      "upstream",
      `failed to fetch recipe url (${fetchErrorLabel(error)})`,
    );
  }
}

async function readCappedHtml(
  response: Response,
  finalUrl: string,
): Promise<FetchedPage> {
  if (!response.ok) {
    await cancelBody(response);
    throw new RecipeImportError(
      "upstream",
      `recipe url responded with status ${response.status}`,
    );
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml") &&
    !contentType.includes("application/ld+json")
  ) {
    await cancelBody(response);
    throw new RecipeImportError(
      "upstream",
      "recipe url did not return HTML or JSON-LD",
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await cancelBody(response);
    throw new RecipeImportError(
      "upstream",
      "recipe url response is too large",
    );
  }
  const html = await readCappedText(response);
  return { html, finalUrl };
}

async function readCappedText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      throw new RecipeImportError("upstream", "recipe url response is too large");
    }
    return new TextDecoder().decode(buffer);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RecipeImportError(
          "upstream",
          "recipe url response is too large",
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof RecipeImportError) throw error;
    throw new RecipeImportError(
      "upstream",
      "failed while reading recipe url response",
    );
  }
  return text;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore — best-effort socket release
  }
}

function fetchErrorLabel(error: unknown): string {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return "timeout";
  }
  return "network error";
}

// ---------------------------------------------------------------------------
// IP range classification (loopback / private / link-local / metadata / etc).
// ---------------------------------------------------------------------------
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true; // not an address -> fail closed
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const groups = ipv6Groups(ip);
  if (!groups) return true;
  if (groups.every((group) => group === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true; // ::1 loopback
  }
  // IPv4-mapped (::ffff:a.b.c.d) / IPv4-compatible (::a.b.c.d) -> check the v4.
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0xffff || groups[5] === 0)
  ) {
    return isBlockedIpv4(embeddedIpv4(groups));
  }
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address.
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return isBlockedIpv4(embeddedIpv4(groups));
  }
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function embeddedIpv4(groups: number[]): string {
  return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
}

function ipv6Groups(ip: string): number[] | null {
  let text = ip;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  // Fold a trailing embedded IPv4 (::ffff:1.2.3.4) into two hextets.
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    if (lastColon === -1) return null;
    const octets = text
      .slice(lastColon + 1)
      .split(".")
      .map((part) => Number(part));
    if (
      octets.length !== 4 ||
      octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      return null;
    }
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const sides = text.split("::");
  if (sides.length > 2) return null;
  const head = parseHextets(sides[0]);
  const tail = sides.length === 2 ? parseHextets(sides[1]) : [];
  if (!head || !tail) return null;

  if (sides.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...new Array<number>(fill).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

function parseHextets(part: string): number[] | null {
  if (part === "") return [];
  const groups: number[] = [];
  for (const chunk of part.split(":")) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) return null;
    groups.push(Number.parseInt(chunk, 16));
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Bounded schema.org JSON-LD extraction (no HTML parser dependency).
// ---------------------------------------------------------------------------
const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const SCRIPT_TYPE_RE = /type\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/i;

export function extractJsonLd(html: string): JsonLdExtraction {
  const blocks: unknown[] = [];
  let scriptCount = 0;
  let parseFailures = 0;
  SCRIPT_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null = SCRIPT_TAG_RE.exec(html);
  while (match !== null) {
    if (scriptCount >= MAX_JSONLD_BLOCKS) break;
    const attributes = match[1] ?? "";
    const typeMatch = SCRIPT_TYPE_RE.exec(attributes);
    if (typeMatch) {
      const type = typeMatch[1]
        .replace(/^['"]|['"]$/g, "")
        .trim()
        .toLowerCase();
      if (type === "application/ld+json") {
        scriptCount += 1;
        const raw = cleanJsonLdText(match[2] ?? "");
        if (raw && raw.length <= MAX_JSONLD_BYTES) {
          try {
            blocks.push(JSON.parse(raw));
          } catch {
            parseFailures += 1;
          }
        } else if (raw) {
          parseFailures += 1; // oversized block -> treated as unusable
        }
      }
    }
    match = SCRIPT_TAG_RE.exec(html);
  }
  return { blocks, scriptCount, parseFailures };
}

function cleanJsonLdText(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("<!--")) {
    text = text.replace(/^<!--/, "").replace(/-->$/, "").trim();
  }
  text = text
    .replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, "")
    .replace(/\/\*\s*\]\]>\s*\*\/$/, "")
    .trim();
  text = text.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
  return text;
}

export function findSchemaRecipe(
  blocks: unknown[],
): Record<string, unknown> | null {
  const queue: unknown[] = [...blocks];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_GRAPH_NODES) {
    visited += 1;
    const node = queue.shift();
    if (Array.isArray(node)) {
      for (const child of node as unknown[]) queue.push(child);
      continue;
    }
    if (!isRecord(node)) continue;
    if (typeMatchesRecipe(node["@type"])) return node;
    const graph = node["@graph"];
    if (Array.isArray(graph)) {
      for (const child of graph as unknown[]) queue.push(child);
    }
    if (node.mainEntity !== undefined) queue.push(node.mainEntity);
  }
  return null;
}

function typeMatchesRecipe(typeValue: unknown): boolean {
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  return types.some((type) => {
    if (typeof type !== "string") return false;
    const last = type.split("/").pop() ?? type;
    return last.split(":").pop()?.trim().toLowerCase() === "recipe";
  });
}

// ---------------------------------------------------------------------------
// Normalization -> plain RecipeInput-shaped object (validated by parseRecipeInput).
// ---------------------------------------------------------------------------
export function normalizeSchemaRecipe(
  raw: Record<string, unknown>,
  sourceUrl: string,
): Record<string, unknown> {
  const title = firstString(raw.name);
  return {
    title: title ? title.slice(0, MAX_TITLE_LENGTH) : null,
    source: "url",
    sourceId: sourceUrl,
    sourceUrl:
      firstString(raw.url) ?? firstString(raw.mainEntityOfPage) ?? sourceUrl,
    imageUrl: extractImage(raw.image),
    youtubeUrl: extractVideo(raw.video),
    category: firstString(raw.recipeCategory),
    area: firstString(raw.recipeCuisine),
    calories: nutritionNumber(raw, "calories"),
    proteinGrams: nutritionNumber(raw, "proteinContent"),
    carbsGrams: nutritionNumber(raw, "carbohydrateContent"),
    fatGrams: nutritionNumber(raw, "fatContent"),
    isFavorite: false,
    notes: firstString(raw.description),
    ingredients: extractIngredients(raw),
    instructions: extractInstructions(raw.recipeInstructions),
  };
}

function extractIngredients(
  raw: Record<string, unknown>,
): Array<{ name: string; quantity: null }> {
  const source = raw.recipeIngredient ?? raw.ingredients;
  const list = Array.isArray(source)
    ? source
    : typeof source === "string"
      ? [source]
      : [];
  const out: Array<{ name: string; quantity: null }> = [];
  for (const item of list) {
    if (out.length >= MAX_INGREDIENTS) break;
    const name = firstString(item);
    if (name) out.push({ name, quantity: null });
  }
  return out;
}

function extractInstructions(value: unknown): string[] {
  const out: string[] = [];
  collectInstructions(value, out, 0);
  return out.slice(0, MAX_INSTRUCTIONS);
}

function collectInstructions(
  value: unknown,
  out: string[],
  depth: number,
): void {
  if (out.length >= MAX_INSTRUCTIONS || depth > MAX_INSTRUCTION_DEPTH) return;
  if (typeof value === "string") {
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && out.length < MAX_INSTRUCTIONS) out.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectInstructions(item, out, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  // HowToSection -> descend into its ordered steps.
  if (value.itemListElement !== undefined) {
    collectInstructions(value.itemListElement, out, depth + 1);
    return;
  }
  // HowToStep -> prefer the step text, fall back to its name.
  const text = firstString(value.text) ?? firstString(value.name);
  if (text) out.push(text);
}

function extractImage(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractImage(item);
      if (url) return url;
    }
    return null;
  }
  if (isRecord(value)) {
    return (
      firstString(value.url) ??
      firstString(value.contentUrl) ??
      firstString(value["@id"]) ??
      null
    );
  }
  return null;
}

function extractVideo(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractVideo(item);
      if (url) return url;
    }
    return null;
  }
  if (isRecord(value)) {
    return (
      firstString(value.embedUrl) ??
      firstString(value.contentUrl) ??
      firstString(value.url) ??
      null
    );
  }
  return null;
}

function nutritionNumber(raw: Record<string, unknown>, key: string): number {
  const nutrition = raw.nutrition;
  if (!isRecord(nutrition)) return 0;
  return parseNumericString(nutrition[key]);
}

function parseNumericString(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }
  if (typeof value !== "string") return 0;
  const match = value.match(/\d+(?:\.\d+)?/);
  if (!match) return 0;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(value)) {
    return (
      firstString(value["@value"]) ??
      firstString(value.name) ??
      firstString(value.url) ??
      null
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------
function canonicalizeUrl(url: URL): string {
  const canonical = new URL(url.toString());
  canonical.hash = "";
  return canonical.toString();
}

function safeParseUrl(value: string, base?: URL): URL | null {
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
