// Runs Convex and the sidecar gateway together, publishing deployment
// discovery metadata and converging machine-local trust credentials.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { publishConvexDeployment } from "../platform/convex/registry";
import { ensureLocalTrust, type DeploymentEnv } from "../platform/convex/secrets";

export type DevSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: "inherit" },
) => ChildProcess;

export type DevSupervisorOptions = {
  spawn?: DevSpawn;
  convexArgs?: readonly string[];
  gatewayArgs?: readonly string[];
  deploymentEnv?: DeploymentEnv;
  publish?: () => { url: string } | null;
  ensureTrust?: (env: DeploymentEnv) => boolean;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  exit?: (code: number) => never | void;
};

export type DevSupervisor = {
  convex: ChildProcess;
  gateway: ChildProcess;
  stop(signal?: NodeJS.Signals): void;
};

/** Start both local runtimes; a peer failure tears down the other child. */
export function startDevSupervisor(options: DevSupervisorOptions = {}): DevSupervisor {
  const spawnChild = options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  const convex = spawnChild("bunx", ["convex", "dev", ...(options.convexArgs ?? Bun.argv.slice(2))], { stdio: "inherit" });
  const gateway = spawnChild("bun", ["src/platform/gateway/server.ts", ...(options.gatewayArgs ?? [])], { stdio: "inherit" });
  const children = [convex, gateway];
  let stopping = false;
  let exited = 0;
  let exitCode = 0;
  let finished = false;
  const exitedChildren = new Set<ChildProcess>();

  const finish = (code: number, reason: string): void => {
    if (finished) return;
    stopping = true;
    exitCode = code;
    console.error(`anorvis: ${reason}; stopping the other runtime`);
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // A child that already exited needs no further signal.
      }
    }
    if (exited >= children.length) {
      finished = true;
      options.exit?.(exitCode);
    }
  };

  const onExit = (child: ChildProcess, name: string, code: number | null, signal: NodeJS.Signals | null): void => {
    if (exitedChildren.has(child)) return;
    exitedChildren.add(child);
    exited += 1;
    if (!stopping) {
      finish(code ?? 1, `${name} exited${signal ? ` on ${signal}` : ` with code ${code ?? 1}`}`);
      return;
    }
    if (exited >= children.length && !finished) {
      finished = true;
      options.exit?.(exitCode);
    }
  };
  convex.on("exit", (code, signal) => onExit(convex, "Convex", code, signal));
  gateway.on("exit", (code, signal) => onExit(gateway, "gateway", code, signal));
  convex.on("error", () => onExit(convex, "Convex", 1, null));
  gateway.on("error", () => onExit(gateway, "gateway", 1, null));

  const stop = (signal: NodeJS.Signals = "SIGTERM"): void => {
    if (stopping) return;
    stopping = true;
    exitCode = 0;
    for (const child of children) {
      try {
        child.kill(signal);
      } catch {
        // A child that already exited needs no further signal.
      }
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop(signal));

  const publish = options.publish ?? (() => publishConvexDeployment(process.cwd()));
  const trust = options.ensureTrust ?? ensureLocalTrust;
  const deploymentEnv = options.deploymentEnv ?? {
    get(name: string) {
      const result = spawnSync("bunx", ["convex", "env", "get", name], { encoding: "utf8" });
      if (result.status !== 0) return null;
      const value = result.stdout.trim();
      return value || null;
    },
    set(name: string, value: string) {
      const result = spawnSync("bunx", ["convex", "env", "set", name, value], { encoding: "utf8" });
      return result.status === 0;
    },
  } satisfies DeploymentEnv;
  let registered = false;
  let trusted = false;
  const deadline = Date.now() + 180_000;
  const timer = (options.setInterval ?? globalThis.setInterval)(() => {
    if (!registered) {
      const deployment = publish();
      if (deployment !== null) {
        console.error(`anorvis: Convex deployment registered at ${deployment.url}`);
        registered = true;
      }
    }
    if (registered && !trusted && trust(deploymentEnv)) {
      console.error("anorvis: local trust keys are in place");
      trusted = true;
    }
    if ((registered && trusted) || Date.now() > deadline) (options.clearInterval ?? globalThis.clearInterval)(timer);
  }, 2_000);
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref();

  return { convex, gateway, stop };
}

if (import.meta.main) startDevSupervisor();
