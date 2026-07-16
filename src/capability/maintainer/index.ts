import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
export type VaultLoginLauncher = (scriptPath: string) => void;

export type VaultLoginResult = {
  ok: true;
} | {
  ok: false;
  error: string;
};

const COMMAND_TIMEOUT_MS = 10_000;
const SMOKE_TIMEOUT_MS = 240_000;
const MAX_CREDENTIAL_VALUE_LENGTH = 512;
const MAX_SMOKE_OUTPUT_LENGTH = 2_000;
const PREFLIGHT_REPOSITORIES = ["anorvis/extension", "anorvis/os", "anorvis/web"] as const;
const API_KEY_NAME = /^[A-Z][A-Z0-9_]*_API_KEY$/;
const ALLOWED_SMOKE_ARGUMENTS = [
  "--print",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "Reply with exactly: SANDBOX-OK",
] as const;

type Environment = Record<string, string | undefined>;

type CommandResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
};

export type MaintainerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
export type MaintainerCommandRunner = (
  command: string,
  args: readonly string[],
  options: {
    timeout: number;
    cwd?: string;
    env?: Environment;
  },
) => CommandResult;

export type MaintainerOptions = {
  env?: Environment;
  sandboxDir?: string;
  commandRunner?: MaintainerCommandRunner;
  fetch?: MaintainerFetch;
  tempDirectory?: string;
  platform?: string;
  vaultLoginLauncher?: VaultLoginLauncher;
};

export type MaintainerStatus = {
  enabled: boolean;
  sandboxCommand: {
    registered: boolean;
    path: string | null;
    exists: boolean;
  };
  docker: boolean;
  sandboxImage: boolean;
  modelAuth: {
    vault: boolean;
    apiKeys: string[];
  };
  githubToken: boolean;
  botBrowserSession: boolean;
  maintainerModel: string | null;
  vaultSetupCommand: string;
};

export type MaintainerCredentials = {
  githubToken?: string;
  apiKeys?: Record<string, string>;
};

export type MaintainerPreflightRepository = {
  repo: string;
  verdict: "push access" | "no push access" | `HTTP ${number}` | "unreachable";
};

export type MaintainerPreflight = {
  ok: boolean;
  repos: MaintainerPreflightRepository[];
};

export type MaintainerSmoke = {
  ok: boolean;
  output: string;
};

export function agentSettingsPath(env: Environment = process.env): string {
  return env.ANORVIS_AGENT_SETTINGS_PATH?.trim() || join(envHome(env), ".anorvis", "agents.json");
}

export function sandboxDirectory(env: Environment = process.env, override?: string): string {
  return override?.trim() || env.ANORVIS_SANDBOX_DIR?.trim() || join(envHome(env), ".anorvis", "sandbox");
}

export function getMaintainerStatus(options: MaintainerOptions = {}): MaintainerStatus {
  const env = options.env ?? process.env;
  const sandboxDir = sandboxDirectory(env, options.sandboxDir);
  const settings = readSettings(agentSettingsPath(env));
  const commandPath = stringValue(settings.sandboxCommand);
  const model = stringValue(settings.maintainerModel);
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const commandExists = commandPath ? existsSync(commandPath) : false;
  const docker = commandSucceeded(commandRunner, "docker", ["version"], COMMAND_TIMEOUT_MS);
  return {
    enabled: settings.maintainerEnabled === true,
    sandboxCommand: {
      registered: commandPath !== null,
      path: commandPath,
      exists: commandExists,
    },
    docker,
    sandboxImage: docker && sandboxImageAvailable(commandRunner, commandPath),
    modelAuth: {
      vault: vaultHasActiveCredential(join(sandboxDir, "agent")),
      apiKeys: readCredentialNames(join(sandboxDir, "env")),
    },
    githubToken: hasStoredGitHubToken(join(sandboxDir, "env")),
    botBrowserSession:
      existsSync(join(sandboxDir, "github-bot-cookies.json")) ||
      existsSync(join(envHome(env), ".anorvis", "maintainer", "github-cookies.json")),
    maintainerModel: model,
    vaultSetupCommand: `PI_CODING_AGENT_DIR=${join(sandboxDir, "agent")} omp`,
  };
}
export function launchMaintainerVaultLogin(options: MaintainerOptions = {}): VaultLoginResult {
  const env = options.env ?? process.env;
  const agentDirectory = join(sandboxDirectory(env, options.sandboxDir), "agent");
  const manualCommand = `PI_CODING_AGENT_DIR=${agentDirectory} omp`;
  if ((options.platform ?? process.platform) !== "darwin") {
    return { ok: false, error: `Interactive vault login is only supported on macOS. Run: ${manualCommand}` };
  }
  try {
    const scriptDirectory = mkdtempSync(join(options.tempDirectory ?? tmpdir(), "anorvis-maintainer-vault-login-"));
    const scriptPath = join(scriptDirectory, "login.sh");
    writeFileSync(scriptPath, `#!/bin/sh\nexec env PI_CODING_AGENT_DIR=${shellQuote(agentDirectory)} omp\n`, {
      encoding: "utf8",
      mode: 0o700,
      flag: "wx",
    });
    chmodSync(scriptPath, 0o700);
    if (options.vaultLoginLauncher) {
      options.vaultLoginLauncher(scriptPath);
    } else {
      const result = spawnSync("open", ["-a", "Terminal", scriptPath], {
        timeout: COMMAND_TIMEOUT_MS,
        stdio: "ignore",
      });
      if (result.status !== 0) throw new Error("unable to open Terminal");
    }
    return { ok: true };
  } catch {
    return { ok: false, error: `Unable to open the dedicated vault login. Run: ${manualCommand}` };
  }
}


function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function updateMaintainerSettings(enabled: boolean, options: MaintainerOptions = {}): void {
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
  const env = options.env ?? process.env;
  const path = agentSettingsPath(env);
  const settings = readSettings(path);
  settings.maintainerEnabled = enabled;
  atomicWrite(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function updateMaintainerCredentials(
  credentials: MaintainerCredentials,
  options: MaintainerOptions = {},
): void {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    throw new Error("credentials must be an object");
  }
  const updates: Record<string, string> = {};
  if (credentials.githubToken !== undefined) {
    validateCredentialValue(credentials.githubToken, "githubToken");
    updates.GH_TOKEN = credentials.githubToken;
  }
  if (credentials.apiKeys !== undefined) {
    if (!credentials.apiKeys || typeof credentials.apiKeys !== "object" || Array.isArray(credentials.apiKeys)) {
      throw new Error("apiKeys must be an object");
    }
    for (const [name, value] of Object.entries(credentials.apiKeys)) {
      if (!API_KEY_NAME.test(name)) throw new Error(`invalid api key name: ${name}`);
      validateCredentialValue(value, name);
      updates[name] = value;
    }
  }
  const env = options.env ?? process.env;
  const path = join(sandboxDirectory(env, options.sandboxDir), "env");
  const existing = readTextIfPresent(path);
  const lines = existing === null ? [] : existing.split("\n");
  if (lines.length && lines.at(-1) === "") lines.pop();
  for (const [name, value] of Object.entries(updates)) {
    let found = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (credentialLineName(lines[index]) !== name) continue;
      lines[index] = `${name}=${value}`;
      found = true;
    }
    if (!found) lines.push(`${name}=${value}`);
  }
  const output = lines.length ? `${lines.join("\n")}\n` : "";
  atomicWrite(path, output);
}

export async function runMaintainerPreflight(options: MaintainerOptions = {}): Promise<MaintainerPreflight> {
  const env = options.env ?? process.env;
  const token = readStoredGitHubToken(join(sandboxDirectory(env, options.sandboxDir), "env"));
  const request = options.fetch ?? globalThis.fetch;
  const repos: MaintainerPreflightRepository[] = [];
  for (const repo of PREFLIGHT_REPOSITORIES) {
    repos.push(await preflightRepository(repo, token, request));
  }
  return { ok: repos.every((entry) => entry.verdict === "push access"), repos };
}

export function runMaintainerSmoke(options: MaintainerOptions = {}): MaintainerSmoke {
  const env = options.env ?? process.env;
  const commandPath = stringValue(readSettings(agentSettingsPath(env)).sandboxCommand);
  if (!commandPath) return { ok: false, output: "sandbox command not configured" };
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const parent = options.tempDirectory ?? tmpdir();
  const workdir = mkdtempSync(join(parent, "anorvis-maintainer-smoke-"));
  try {
    const commandEnv: Environment = {
      HOME: workdir,
      PWD: workdir,
      TMPDIR: workdir,
      PATH: env.PATH ?? "",
    };
    const result = safeCommandRun(commandRunner, commandPath, ALLOWED_SMOKE_ARGUMENTS, {
      timeout: SMOKE_TIMEOUT_MS,
      cwd: workdir,
      env: commandEnv,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    return {
      ok: result.status === 0 && stdout.includes("SANDBOX-OK"),
      output: boundOutput(stdout + (stderr ? `\n${stderr}` : "")),
    };
  } finally {
    // A smoke run must not leave an agent home or command output behind.
    try {
      rmDirectory(workdir);
    } catch {
      // Best effort cleanup cannot change the smoke result.
    }
  }
}

function envHome(env: Environment): string {
  return env.HOME?.trim() || homedir();
}

function readSettings(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return { ...(parsed as Record<string, unknown>) };
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function commandSucceeded(
  runner: MaintainerCommandRunner,
  command: string,
  args: readonly string[],
  timeout: number,
): boolean {
  try {
    return runner(command, args, { timeout }).status === 0;
  } catch {
    return false;
  }
}

function sandboxImageAvailable(runner: MaintainerCommandRunner, commandPath: string | null): boolean {
  const imageVersion = commandPath ? readSandboxImageVersion(commandPath) : null;
  if (imageVersion && commandSucceeded(runner, "docker", ["image", "inspect", `anorvis-sandbox:${imageVersion}`], COMMAND_TIMEOUT_MS)) {
    return true;
  }
  let listed: CommandResult;
  try {
    listed = runner("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}", "anorvis-sandbox"], { timeout: COMMAND_TIMEOUT_MS });
  } catch {
    return false;
  }
  const candidates = `${listed.stdout ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^anorvis-sandbox(?::[^\s]+)?$/.test(line));
  return candidates.some((candidate) => commandSucceeded(runner, "docker", ["image", "inspect", candidate], COMMAND_TIMEOUT_MS));
}

function readSandboxImageVersion(commandPath: string): string | null {
  try {
    const dockerfile = join(dirname(resolve(commandPath)), "Dockerfile");
    const source = readFileSync(dockerfile, "utf8");
    return source.match(/^\s*ARG\s+OMP_VERSION\s*=\s*([^\s#]+)/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The vault counts as authenticated only when OMP's credential store holds a
 * non-disabled row. A merely initialized agent directory (empty agent.db from
 * a prior worker run) must not report model auth as ready. Read-only and
 * fail-closed: any missing file, foreign schema, or query error means false,
 * and no credential data is ever read — only a count.
 */
export function vaultHasActiveCredential(vaultDir: string): boolean {
  const databasePath = join(vaultDir, "agent.db");
  if (!existsSync(databasePath)) return false;
  try {
    const database = new Database(databasePath, { readonly: true });
    try {
      const row: unknown = database
        .query("SELECT count(*) AS active FROM auth_credentials WHERE disabled_cause IS NULL")
        .get();
      return (
        typeof row === "object" &&
        row !== null &&
        "active" in row &&
        typeof row.active === "number" &&
        row.active > 0
      );
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

function credentialLineName(line: string): string | null {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  return match?.[1] ?? null;
}

function readCredentialNames(path: string): string[] {
  const text = readTextIfPresent(path);
  if (text === null) return [];
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const name = credentialLineName(line);
    if (!name || !name.endsWith("_API_KEY")) continue;
    const value = line.slice(name.length + 1);
    if (value.trim()) names.add(name);
  }
  return [...names].sort();
}

function readStoredGitHubToken(path: string): string | null {
  const text = readTextIfPresent(path);
  if (text === null) return null;
  for (const line of text.split(/\r?\n/)) {
    const name = credentialLineName(line);
    if (name !== "GH_TOKEN" && name !== "GITHUB_TOKEN") continue;
    const value = line.slice(name.length + 1).trim();
    if (value) return value;
  }
  return null;
}

function hasStoredGitHubToken(path: string): boolean {
  return readStoredGitHubToken(path) !== null;
}

async function preflightRepository(
  repo: string,
  token: string | null,
  request: MaintainerFetch,
): Promise<MaintainerPreflightRepository> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  try {
    const response = await request(`https://api.github.com/repos/${repo}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "anorvis-maintainer-preflight",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) return { repo, verdict: `HTTP ${response.status}` };
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const push = isRecord(payload) && isRecord(payload.permissions) && payload.permissions.push === true;
    return { repo, verdict: push ? "push access" : "no push access" };
  } catch {
    return { repo, verdict: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

function validateCredentialValue(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_CREDENTIAL_VALUE_LENGTH || /[\r\n]/.test(value) || value.includes("\0")) {
    throw new Error(`${name} must be a single-line value of at most ${MAX_CREDENTIAL_VALUE_LENGTH} characters`);
  }
}

function readTextIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

function boundOutput(value: string): string {
  return value.length <= MAX_SMOKE_OUTPUT_LENGTH ? value : value.slice(0, MAX_SMOKE_OUTPUT_LENGTH);
}

function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options: { timeout: number; cwd?: string; env?: Environment },
): CommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function safeCommandRun(
  runner: MaintainerCommandRunner,
  command: string,
  args: readonly string[],
  options: { timeout: number; cwd?: string; env?: Environment },
): CommandResult {
  try {
    return runner(command, args, options);
  } catch (error) {
    return { status: null, stderr: error instanceof Error ? error.message : "command failed" };
  }
}

function rmDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
