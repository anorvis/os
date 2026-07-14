import { spawn, spawnSync } from "node:child_process";

export type AgentProcessResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  outputLimited: boolean;
};

export type AgentProcessInput = {
  command: string;
  args: string[];
  cwd: string;
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  killGraceMs?: number;
  onStdout?: (chunk: string) => void;
};

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 10_000;
const STREAM_DRAIN_MS = 1_000;

export function runAgentProcess(
  input: AgentProcessInput,
): Promise<AgentProcessResult> {
  const { promise, resolve } = Promise.withResolvers<AgentProcessResult>();
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let cancelled = false;
  let outputLimited = false;
  let stopping = false;
  let settled = false;
  let escalationTimer: NodeJS.Timeout | undefined;

  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(escalationTimer);
    input.signal?.removeEventListener("abort", abort);
    resolve({ stdout, stderr, code, timedOut, cancelled, outputLimited });
  };
  const terminate = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    terminate("SIGTERM");
    escalationTimer = setTimeout(
      () => terminate("SIGKILL"),
      input.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    );
    escalationTimer.unref();
  };
  const abort = () => {
    cancelled = true;
    stop();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, input.timeoutMs);
  const capture = (current: string, chunk: unknown): string => {
    if (outputLimited) return current;
    const bytes = Buffer.from(String(chunk));
    const max = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const used = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    const remaining = Math.max(0, max - used);
    const next = current + bytes.subarray(0, remaining).toString();
    if (bytes.byteLength > remaining) {
      outputLimited = true;
      clearTimeout(timer);
      stop();
    }
    return next;
  };

  child.stdout.on("data", (chunk) => {
    input.onStdout?.(String(chunk));
    stdout = capture(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = capture(stderr, chunk);
  });
  child.on("error", (error) => {
    stderr = capture(stderr, error.message);
    finish(1);
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    setTimeout(() => finish(code), STREAM_DRAIN_MS).unref();
  });
  child.on("close", finish);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  return promise;
}
