import {
  chmodSync,
  type FSWatcher,
  mkdirSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import type { LocalAuthorityConfig } from "../../core/config/local-authority";
import {
  listMaintenanceTickets,
  maintenanceRoot,
  updateMaintenanceTicket,
  type MaintenanceTicket,
  type MaintenanceTicketStatus,
} from ".";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const DEFAULT_RETURN_TO = "http://localhost:3000/dev";
const STATE_TTL_MS = 10 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1_024;
const MAX_ERROR_LENGTH = 240;
const MAX_CREDENTIAL_LENGTH = 512;

export type LinearFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type LinearLink = {
  issueId: string;
  identifier: string;
  url: string;
};

export type LinearConfig = {
  version: 1;
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  accessToken?: string;
  teamId?: string;
  teamName?: string;
  pending?: {
    stateHash: string;
    returnTo: string;
    expiresAt: number;
  };
  links: Record<string, LinearLink>;
};

export type LinearOptions = {
  root?: string;
  fetch?: LinearFetch;
  config?: Pick<LocalAuthorityConfig, "bindHost" | "port">;
  now?: Date | (() => Date);
};

export type LinearStatus = {
  connected: boolean;
  auth: "oauth" | "api_key" | null;
  teamId: string | null;
  teamName: string | null;
  hasClientCredentials: boolean;
};

export type LinearTeam = {
  id: string;
  name: string;
  key: string;
};

export type LinearSyncResult = {
  ok: boolean;
  pushed: number;
  updated: number;
  error?: string;
};

export type LinearCallbackResult = {
  ok: boolean;
  redirect?: string;
  error?: string;
};

let syncInFlight: Promise<LinearSyncResult> | undefined;

export function linearPath(root?: string): string {
  return join(maintenanceRoot(root), "linear.json");
}

export function readLinearConfig(options: { root?: string } = {}): LinearConfig {
  const path = linearPath(options.root);
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parseConfig(value);
  } catch {
    return { version: 1, links: {} };
  }
}

export function readLinearLinks(options: { root?: string } = {}): Record<string, LinearLink> {
  return { ...readLinearConfig(options).links };
}

export function getLinearStatus(options: { root?: string } = {}): LinearStatus {
  const config = readLinearConfig(options);
  const auth = config.apiKey ? "api_key" : config.accessToken ? "oauth" : null;
  return {
    connected: auth !== null,
    auth,
    teamId: config.teamId ?? null,
    teamName: config.teamName ?? null,
    hasClientCredentials: Boolean(config.clientId && config.clientSecret),
  };
}

export async function saveLinearCredentials(
  input: { clientId?: string; clientSecret?: string; apiKey?: string },
  options: LinearOptions = {},
): Promise<void> {
  if (!input || typeof input !== "object") throw new Error("credentials must be an object");
  const supplied = Object.entries(input).filter(([, value]) => value !== undefined);
  if (supplied.length === 0) throw new Error("at least one credential is required");
  for (const [name, value] of supplied) validateCredential(value, name);

  const current = readLinearConfig(options);
  const next: LinearConfig = { ...current, links: { ...current.links } };
  if (input.clientId !== undefined) next.clientId = input.clientId;
  if (input.clientSecret !== undefined) next.clientSecret = input.clientSecret;
  if (input.apiKey !== undefined) {
    const candidate: LinearConfig = { ...next, apiKey: input.apiKey };
    delete candidate.accessToken;
    await linearViewer(candidate, options);
    next.apiKey = input.apiKey;
    delete next.accessToken;
  }
  writeConfig(linearPath(options.root), next);
}

export function createLinearAuthorization(
  input: { returnTo?: string } = {},
  options: LinearOptions = {},
): { authorizationUrl: string } {
  const config = readLinearConfig(options);
  if (!config.clientId || !config.clientSecret) throw new Error("Linear OAuth client credentials are required");
  const returnTo = validateReturnTo(input.returnTo ?? DEFAULT_RETURN_TO);
  const state = randomBytes(32).toString("hex");
  const pending: NonNullable<LinearConfig["pending"]> = {
    stateHash: hashState(state),
    returnTo,
    expiresAt: now(options).getTime() + STATE_TTL_MS,
  };
  writeConfig(linearPath(options.root), { ...config, pending });
  const redirectUri = linearRedirectUri(options.config);
  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "read,write");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("actor", "user");
  return { authorizationUrl: url.toString() };
}

export async function handleLinearCallback(
  input: { code?: string; state?: string },
  options: LinearOptions = {},
): Promise<LinearCallbackResult> {
  const config = readLinearConfig(options);
  const pending = config.pending;
  if (!pending || !input.state || !safeStateEqual(input.state, pending.stateHash) || pending.expiresAt <= now(options).getTime()) {
    return { ok: false, error: "invalid or expired OAuth state" };
  }
  const returnTo = pending.returnTo;
  const consumed: LinearConfig = { ...config };
  delete consumed.pending;
  writeConfig(linearPath(options.root), consumed);
  if (!input.code) return callbackError(returnTo, "authorization code is required");

  try {
    const accessToken = await exchangeLinearCode(input.code, consumed, options);
    const connected: LinearConfig = { ...consumed, accessToken, links: { ...consumed.links } };
    delete connected.apiKey;
    writeConfig(linearPath(options.root), connected);
    return { ok: true, redirect: callbackRedirect(returnTo, "linear", "connected") };
  } catch (error) {
    return callbackError(returnTo, boundError(error, consumed));
  }
}

export async function listLinearTeams(options: LinearOptions = {}): Promise<{ teams: LinearTeam[] }> {
  const config = readLinearConfig(options);
  requireAuth(config);
  const data = await graphql("query { teams { nodes { id name key } } }", {}, config, options);
  const rows = readObject(data, "teams")?.nodes;
  if (!Array.isArray(rows)) throw new Error("Linear returned an invalid team list");
  const teams: LinearTeam[] = [];
  for (const row of rows) {
    const value = readObject(row);
    const id = stringValue(value?.id);
    const name = stringValue(value?.name);
    const key = stringValue(value?.key);
    if (id && name && key) teams.push({ id, name, key });
  }
  return { teams };
}

export async function selectLinearTeam(teamId: string, options: LinearOptions = {}): Promise<{ ok: true; teamName: string }> {
  if (typeof teamId !== "string" || !teamId.trim()) throw new Error("teamId must be a non-empty string");
  const teams = await listLinearTeams(options);
  const team = teams.teams.find((item) => item.id === teamId);
  if (!team) throw new Error("Linear team was not found");
  const config = readLinearConfig(options);
  writeConfig(linearPath(options.root), { ...config, teamId: team.id, teamName: team.name });
  return { ok: true, teamName: team.name };
}

export function disconnectLinear(options: { root?: string } = {}): { ok: true } {
  const config = readLinearConfig(options);
  writeConfig(linearPath(options.root), { version: 1, links: { ...config.links } });
  return { ok: true };
}

export function syncLinearTickets(options: LinearOptions = {}): Promise<LinearSyncResult> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = syncLinearTicketsInternal(options).finally(() => {
    syncInFlight = undefined;
  });
  return syncInFlight;
}
const SYNC_DEBOUNCE_MS = 3_000;
const SYNC_MIN_INTERVAL_MS = 60_000;

export type LinearSyncWatcher = { start(): void; stop(): void };

/**
 * Keep the Linear board fresh without polling: monitor-root file changes
 * (tickets created by the extension, monitor activity) debounce into one
 * best-effort sync, and gateway start reconciles anything written while the
 * gateway was down. Idle installs schedule nothing.
 */
export function createLinearSyncWatcher(options: LinearOptions = {}): LinearSyncWatcher {
  const root = maintenanceRoot(options.root);
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSyncAt = 0;
  let stopped = true;
  const run = (): void => {
    timer = undefined;
    lastSyncAt = Date.now();
    void syncLinearTickets(options).catch(() => {
      // Watcher syncs are best-effort freshness; failures surface through
      // the web panel's explicit sync instead.
    });
  };
  const schedule = (): void => {
    if (stopped || timer) return;
    const wait = Math.max(SYNC_DEBOUNCE_MS, lastSyncAt + SYNC_MIN_INTERVAL_MS - Date.now());
    timer = setTimeout(run, wait);
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      mkdirSync(root, { recursive: true, mode: 0o700 });
      try {
        watcher = watch(root, (_event, filename) => {
          // The sync's own linear.json write must not re-trigger itself.
          if (filename === "linear.json" || filename?.startsWith("linear.json.")) return;
          schedule();
        });
      } catch {
        // fs.watch is best-effort; explicit syncs still work without it.
        watcher = undefined;
      }
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      watcher?.close();
      watcher = undefined;
    },
  };
}

export async function pushLinearTicketState(
  ticketId: string,
  stateType: "unstarted" | "canceled",
  options: LinearOptions = {},
): Promise<void> {
  const config = readLinearConfig(options);
  if (!config.teamId || !hasAuth(config)) return;
  const link = config.links[ticketId];
  if (!link) return;
  const data = await graphql(
    "query($teamId: String!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id type position } } }",
    { teamId: config.teamId },
    config,
    options,
  );
  const rows = readObject(data, "workflowStates")?.nodes;
  if (!Array.isArray(rows)) throw new Error("Linear returned an invalid workflow state list");
  const states = rows
    .map((row) => {
      const value = readObject(row);
      return { id: stringValue(value?.id), type: stringValue(value?.type), position: numberValue(value?.position) };
    })
    .filter((row): row is { id: string; type: string; position: number } => Boolean(row.id && row.type === stateType));
  states.sort((a, b) => a.position - b.position);
  const state = states[0];
  if (!state) throw new Error(`Linear has no ${stateType} workflow state`);
  const result = await graphql(
    "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }",
    { id: link.issueId, stateId: state.id },
    config,
    options,
  );
  const success = readObject(result.issueUpdate)?.success;
  if (success !== true) throw new Error("Linear rejected the issue state update");
}

async function syncLinearTicketsInternal(options: LinearOptions): Promise<LinearSyncResult> {
  const config = readLinearConfig(options);
  if (!config.teamId || !hasAuth(config)) return { ok: true, pushed: 0, updated: 0 };
  let pushed = 0;
  let updated = 0;
  try {
    const tickets = listMaintenanceTickets({ root: options.root });
    for (const ticket of tickets) {
      if (ticket.status !== "pending_approval") continue;
      const link = config.links[ticket.id];
      if (!link) continue;
      const data = await graphql(
        "query($id: String!) { issue(id: $id) { state { type } } }",
        { id: link.issueId },
        config,
        options,
      );
      const issue = readObject(data, "issue");
      const stateType = stringValue(readObject(issue?.state)?.type);
      const status = linearStatus(stateType);
      if (status) {
        const changed = updateMaintenanceTicket(ticket.id, { status }, { root: options.root });
        if (changed) updated++;
      }
    }

    const current = listMaintenanceTickets({ root: options.root });
    for (const ticket of current) {
      if (ticket.status !== "pending_approval" || config.links[ticket.id]) continue;
      const marker = `anorvis-ticket:${ticket.id}`;
      const found = await findLinearIssue(marker, config, options);
      const link = found ?? await createLinearIssue(ticket, marker, config, options);
      if (link) {
        config.links[ticket.id] = link;
        writeConfig(linearPath(options.root), config);
        if (!found) pushed++;
      }
    }
    return { ok: true, pushed, updated };
  } catch (error) {
    return { ok: false, pushed, updated, error: boundError(error, config) };
  }
}

async function findLinearIssue(marker: string, config: LinearConfig, options: LinearOptions): Promise<LinearLink | undefined> {
  const data = await graphql(
    "query($marker: String!) { issues(filter: { description: { contains: $marker } }, first: 1) { nodes { id identifier url } } }",
    { marker },
    config,
    options,
  );
  const rows = readObject(data, "issues")?.nodes;
  if (!Array.isArray(rows)) throw new Error("Linear returned an invalid issue search result");
  for (const row of rows) {
    const value = readObject(row);
    const issueId = stringValue(value?.id);
    const identifier = stringValue(value?.identifier);
    const url = stringValue(value?.url);
    if (issueId && identifier && url) return { issueId, identifier, url };
  }
  return undefined;
}

async function createLinearIssue(
  ticket: MaintenanceTicket,
  marker: string,
  config: LinearConfig,
  options: LinearOptions,
): Promise<LinearLink> {
  const title = ticket.task.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Anorvis maintenance ticket";
  if (!config.teamId) throw new Error("Linear team is not selected");
  const data = await graphql(
    "mutation($teamId: String!, $title: String!, $description: String!) { issueCreate(input: { teamId: $teamId, title: $title, description: $description }) { success issue { id identifier url } } }",
    { teamId: config.teamId, title, description: `${ticket.task}\n\n---\n${marker}` },
    config,
    options,
  );
  const created = readObject(data, "issueCreate");
  if (created?.success !== true) throw new Error("Linear rejected issue creation");
  const issue = readObject(created.issue);
  const issueId = stringValue(issue?.id);
  const identifier = stringValue(issue?.identifier);
  const url = stringValue(issue?.url);
  if (!issueId || !identifier || !url) throw new Error("Linear returned an invalid created issue");
  return { issueId, identifier, url };
}

async function linearViewer(config: LinearConfig, options: LinearOptions): Promise<void> {
  requireAuth(config);
  const data = await graphql("query { viewer { id } }", {}, config, options);
  const id = stringValue(readObject(data, "viewer")?.id);
  if (!id) throw new Error("Linear authentication was rejected");
}

async function exchangeLinearCode(code: string, config: LinearConfig, options: LinearOptions): Promise<string> {
  if (!config.clientId || !config.clientSecret) throw new Error("Linear OAuth client credentials are required");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: linearRedirectUri(options.config),
  });
  const response = await fetchWithTimeout(options.fetch ?? globalThis.fetch, LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const value = await readResponse(response);
  if (!response.ok) throw new Error(`Linear OAuth token exchange failed (${response.status})`);
  const token = stringValue(readObject(value)?.access_token);
  if (!token) throw new Error("Linear OAuth token response was invalid");
  return token;
}

async function graphql(
  query: string,
  variables: Record<string, string>,
  config: LinearConfig,
  options: LinearOptions,
): Promise<Record<string, unknown>> {
  requireAuth(config);
  const response = await fetchWithTimeout(options.fetch ?? globalThis.fetch, LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: config.apiKey ?? `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const value = await readResponse(response);
  if (!response.ok) throw new Error(`Linear request failed (${response.status})`);
  const errors = readObject(value)?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = readObject(errors[0]);
    throw new Error(stringValue(first?.message) || "Linear request failed");
  }
  const data = readObject(value)?.data;
  if (!isRecord(data)) throw new Error("Linear response was invalid");
  return data;
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("Linear response was too large");
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error("Linear response was invalid");
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === "Linear response was invalid") throw error;
    throw new Error("Linear response was not JSON");
  }
}

async function fetchWithTimeout(fetcher: LinearFetch, input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function callbackError(returnTo: string, message: string): LinearCallbackResult {
  return { ok: false, error: message, redirect: callbackRedirect(returnTo, "linear_error", message) };
}

function callbackRedirect(returnTo: string, key: "linear" | "linear_error", value: string): string {
  const url = new URL(returnTo);
  url.searchParams.set(key, boundText(value));
  return url.toString();
}

function linearRedirectUri(config?: Pick<LocalAuthorityConfig, "bindHost" | "port">): string {
  return `http://127.0.0.1:${config?.port ?? 8787}/v1/maintenance/linear/callback`;
}

function validateReturnTo(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("returnTo must be a loopback URL");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "::1" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopback || url.username || url.password || url.hash) {
    throw new Error("returnTo must be a loopback URL");
  }
  return url.toString();
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function safeStateEqual(state: string, stateHash: string): boolean {
  const actual = Buffer.from(hashState(state), "hex");
  const expected = Buffer.from(stateHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireAuth(config: LinearConfig): void {
  if (!hasAuth(config)) throw new Error("Linear is not connected");
}

function hasAuth(config: LinearConfig): boolean {
  return Boolean(config.apiKey || config.accessToken);
}

function linearStatus(stateType: string): MaintenanceTicketStatus | undefined {
  if (stateType === "unstarted" || stateType === "started") return "approved";
  if (stateType === "canceled") return "rejected";
  if (stateType === "completed") return "fixed";
  return undefined;
}

function parseConfig(value: unknown): LinearConfig {
  const object = readObject(value);
  const links: Record<string, LinearLink> = {};
  const rawLinks = readObject(object?.links);
  for (const [id, raw] of Object.entries(rawLinks ?? {})) {
    const link = readObject(raw);
    const issueId = stringValue(link?.issueId);
    const identifier = stringValue(link?.identifier);
    const url = stringValue(link?.url);
    if (issueId && identifier && url) links[id] = { issueId, identifier, url };
  }
  const parsed: LinearConfig = { version: 1, links };
  for (const field of ["clientId", "clientSecret", "apiKey", "accessToken", "teamId", "teamName"] as const) {
    const value = stringValue(object?.[field]);
    if (value) parsed[field] = value;
  }
  const pending = readObject(object?.pending);
  const stateHash = stringValue(pending?.stateHash);
  const returnTo = stringValue(pending?.returnTo);
  const expiresAt = numberValue(pending?.expiresAt);
  if (stateHash && returnTo && expiresAt > 0) parsed.pending = { stateHash, returnTo, expiresAt };
  return parsed;
}

function writeConfig(path: string, config: LinearConfig): void {
  const root = dirname(path);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

function now(options: Pick<LinearOptions, "now">): Date {
  const value = typeof options.now === "function" ? options.now() : options.now;
  return value ?? new Date();
}

function validateCredential(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CREDENTIAL_LENGTH || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} must be a non-empty single-line value of at most ${MAX_CREDENTIAL_LENGTH} characters`);
  }
}

function boundError(error: unknown, config?: LinearConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [config?.apiKey, config?.accessToken, config?.clientSecret].filter(Boolean) as string[]) {
    message = message.replaceAll(secret, "[redacted]");
  }
  return boundText(message || "Linear request failed");
}

function boundText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_ERROR_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
  const object = isRecord(value) ? value : undefined;
  if (!key) return object;
  const child = object?.[key];
  return isRecord(child) ? child : undefined;
}


function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
