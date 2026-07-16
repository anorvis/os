import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMaintainerStatus,
  launchMaintainerVaultLogin,
  runMaintainerPreflight,
  runMaintainerSmoke,
  updateMaintainerCredentials,
  updateMaintainerSettings,
  type MaintainerCommandRunner,
} from "../src/capability/maintainer";
import { maintainerRoutes } from "../src/capability/maintainer/route";
import { Hono } from "hono";

test("status reports isolated setup without exposing credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "anorvis-maintainer-status-"));
  const sandbox = join(home, "sandbox");
  const launcherDir = join(home, "launcher");
  const launcher = join(launcherDir, "anorvis-sandbox");
  mkdirSync(join(sandbox, "agent"), { recursive: true });
  writeFileSync(join(sandbox, "agent", "auth.json"), "oauth");
  writeFileSync(join(sandbox, "env"), "# keep\nOPENAI_API_KEY=secret-value\nEMPTY_API_KEY=\nGH_TOKEN=gh-secret\n");
  mkdirSync(join(home, ".anorvis", "maintainer"), { recursive: true });
  writeFileSync(join(home, ".anorvis", "maintainer", "github-cookies.json"), "cookies");
  mkdirSync(launcherDir, { recursive: true });
  writeFileSync(launcher, "");
  writeFileSync(join(launcherDir, "Dockerfile"), "ARG OMP_VERSION=16.5.2\n");
  const settingsPath = join(home, "agents.json");
  writeFileSync(settingsPath, JSON.stringify({ maintainerEnabled: true, maintainerModel: "openai-codex/gpt", sandboxCommand: launcher }));
  const runner: MaintainerCommandRunner = (command, args) => {
    if (command !== "docker") return { status: 1 };
    if (args[0] === "version") return { status: 0 };
    if (args[0] === "image" && args[1] === "inspect") return { status: args[2] === "anorvis-sandbox:16.5.2" ? 0 : 1 };
    return { status: 1 };
  };
  const status = getMaintainerStatus({
    env: { HOME: home, ANORVIS_AGENT_SETTINGS_PATH: settingsPath, ANORVIS_SANDBOX_DIR: sandbox },
    commandRunner: runner,
  });
  expect(status).toMatchObject({
    enabled: true,
    sandboxCommand: { registered: true, path: launcher, exists: true },
    docker: true,
    sandboxImage: true,
    modelAuth: { vault: true, apiKeys: ["OPENAI_API_KEY"] },
    githubToken: true,
    botBrowserSession: true,
    maintainerModel: "openai-codex/gpt",
    vaultSetupCommand: `PI_CODING_AGENT_DIR=${join(sandbox, "agent")} omp`,
  });
  expect(JSON.stringify(status)).not.toContain("secret-value");
  expect(JSON.stringify(status)).not.toContain("gh-secret");
});

test("settings toggle preserves unrelated fields and writes a private file", () => {
  const home = mkdtempSync(join(tmpdir(), "anorvis-maintainer-settings-"));
  const path = join(home, "agents.json");
  writeFileSync(path, JSON.stringify({ maintainerModel: "model", sandboxCommand: "/tmp/sandbox", unrelated: { keep: true } }), { mode: 0o644 });
  updateMaintainerSettings(true, { env: { HOME: home, ANORVIS_AGENT_SETTINGS_PATH: path } });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    maintainerModel: "model",
    sandboxCommand: "/tmp/sandbox",
    unrelated: { keep: true },
    maintainerEnabled: true,
  });
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("credentials upsert comments and rejects unsafe values", () => {
  const home = mkdtempSync(join(tmpdir(), "anorvis-maintainer-credentials-"));
  const sandbox = join(home, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  const path = join(sandbox, "env");
  writeFileSync(path, "# comment\nOTHER=value\nOPENAI_API_KEY=old\n", { mode: 0o644 });
  const env = { HOME: home, ANORVIS_SANDBOX_DIR: sandbox };
  updateMaintainerCredentials({ githubToken: "gh-new", apiKeys: { OPENAI_API_KEY: "new", ANTHROPIC_API_KEY: "also-new" } }, { env });
  expect(readFileSync(path, "utf8")).toBe("# comment\nOTHER=value\nOPENAI_API_KEY=new\nGH_TOKEN=gh-new\nANTHROPIC_API_KEY=also-new\n");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(() => updateMaintainerCredentials({ apiKeys: { bad_name: "x" } }, { env })).toThrow("invalid api key name");
  expect(() => updateMaintainerCredentials({ githubToken: "line1\nline2" }, { env })).toThrow("single-line");
  expect(readFileSync(path, "utf8")).not.toContain("line1");
});

test("preflight reports push, no-push, HTTP and unreachable without token leakage", async () => {
  const home = mkdtempSync(join(tmpdir(), "anorvis-maintainer-preflight-"));
  const sandbox = join(home, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(join(sandbox, "env"), "GH_TOKEN=super-secret-token\n");
  const fetch = (url: string | URL | Request) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const repo = target.split("/repos/")[1];
    if (repo === "anorvis/extension") return Promise.resolve(Response.json({ permissions: { push: true } }));
    if (repo === "anorvis/os") return Promise.resolve(Response.json({ permissions: { push: false } }));
    if (repo === "anorvis/web") return Promise.resolve(new Response("missing", { status: 404 }));
    return Promise.reject(new Error("network"));
  };
  const result = await runMaintainerPreflight({ env: { HOME: home, ANORVIS_SANDBOX_DIR: sandbox }, fetch });
  expect(result).toEqual({
    ok: false,
    repos: [
      { repo: "anorvis/extension", verdict: "push access" },
      { repo: "anorvis/os", verdict: "no push access" },
      { repo: "anorvis/web", verdict: "HTTP 404" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("super-secret-token");
  const unreachable = await runMaintainerPreflight({
    env: { HOME: home, ANORVIS_SANDBOX_DIR: sandbox },
    fetch: () => Promise.reject(new Error("network")),
  });
  expect(unreachable.repos.every((repo) => repo.verdict === "unreachable")).toBe(true);
});

test("smoke invokes the registered command in an isolated temporary home", () => {
  const home = mkdtempSync(join(tmpdir(), "anorvis-maintainer-smoke-"));
  const settingsPath = join(home, "agents.json");
  writeFileSync(settingsPath, JSON.stringify({ sandboxCommand: "/bin/omp" }));
  let received: { args: readonly string[]; cwd?: string; env?: Record<string, string | undefined> } | undefined;
  const result = runMaintainerSmoke({
    env: { HOME: home, PATH: "/bin", ANORVIS_AGENT_SETTINGS_PATH: settingsPath },
    commandRunner: (_command, args, options) => {
      received = { args, cwd: options.cwd, env: options.env };
      return { status: 0, stdout: "SANDBOX-OK\n" };
    },
  });
  expect(result).toEqual({ ok: true, output: "SANDBOX-OK\n" });
  expect(received?.args).toEqual(["--print", "--no-session", "--no-extensions", "--no-skills", "Reply with exactly: SANDBOX-OK"]);
  expect(received?.env).toEqual({ HOME: received?.cwd, PWD: received?.cwd, TMPDIR: received?.cwd, PATH: "/bin" });
  expect(received?.cwd && existsSync(received.cwd)).toBe(false);
});

test("vault login opens a private one-time script and gives a manual command elsewhere", () => {
  const home = mkdtempSync(join(tmpdir(), "anorvis-maintainer-vault-login-"));
  const sandbox = join(home, "sandbox");
  const tempDirectory = join(home, "tmp");
  mkdirSync(tempDirectory, { recursive: true });
  let scriptPath = "";
  const launched = launchMaintainerVaultLogin({
    env: { HOME: home, ANORVIS_SANDBOX_DIR: sandbox },
    platform: "darwin",
    tempDirectory,
    vaultLoginLauncher: (path) => { scriptPath = path; },
  });
  expect(launched).toEqual({ ok: true });
  expect(statSync(scriptPath).mode & 0o777).toBe(0o700);
  expect(readFileSync(scriptPath, "utf8")).toContain(`exec env PI_CODING_AGENT_DIR=${sandbox}/agent omp`);

  const manual = launchMaintainerVaultLogin({ env: { HOME: home, ANORVIS_SANDBOX_DIR: sandbox }, platform: "linux" });
  if (manual.ok) throw new Error("expected manual login result");
  expect(manual.error).toContain(`PI_CODING_AGENT_DIR=${sandbox}/agent omp`);
});

describe("maintainer routes", () => {
  test("registers status and mutation routes", async () => {
    const app = new Hono();
    maintainerRoutes({ env: { HOME: mkdtempSync(join(tmpdir(), "anorvis-maintainer-route-")) }, commandRunner: () => ({ status: 1 }) })(app);
    expect((await app.request("/v1/maintainer/status")).status).toBe(200);
    expect((await app.request("/v1/maintainer/settings", { method: "POST", body: JSON.stringify({ enabled: true }), headers: { "content-type": "application/json" } })).status).toBe(200);
  });
});
