// Runs Convex and the sidecar gateway together, publishing deployment
// discovery metadata and converging machine-local trust credentials.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { publishConvexDeployment } from "../platform/convex/registry";
import { ensureLocalTrust, type DeploymentEnv } from "../platform/convex/secrets";
import { supportedConvexNodeEnv } from "./node-runtime";

export type DevSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: "inherit"; env?: NodeJS.ProcessEnv },
) => ChildProcess;

export type DevSupervisorOptions = {
  spawn?: DevSpawn;
  convexEnv?: NodeJS.ProcessEnv;
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
  gateway?: ChildProcess;
  stop(signal?: NodeJS.Signals): void;
};

/** Start both local runtimes; a peer failure tears down the other child. */
export function startDevSupervisor(options: DevSupervisorOptions = {}): DevSupervisor {
  const spawnChild = options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  // Convex deploys "use node" actions only under Node 18/20/22/24; resolve a
  // supported runtime up front so integrations never silently fail to deploy.
  const convexEnv = options.convexEnv ?? supportedConvexNodeEnv();
  const convex = spawnChild("bunx", ["convex", "dev", ...(options.convexArgs ?? Bun.argv.slice(2))], { stdio: "inherit", env: convexEnv });
  const children: ChildProcess[] = [convex];
  const exitedChildren = new Set<ChildProcess>();
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let gateway: ChildProcess | undefined;
  let stopping = false;
  let exited = 0;
  let exitCode = 0;
  let finished = false;
  let timer: Parameters<typeof globalThis.clearInterval>[0] | undefined;

  const clearBootstrapTimer = (): void => {
    if (timer === undefined) return;
    (options.clearInterval ?? globalThis.clearInterval)(timer);
    timer = undefined;
  };

  const finish = (code: number, reason: string): void => {
    if (finished) return;
    stopping = true;
    exitCode = code;
    clearBootstrapTimer();
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
      exit(exitCode);
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
      clearBootstrapTimer();
      exit(exitCode);
    }
  };

  const attachExitHandlers = (child: ChildProcess, name: string): void => {
    child.on("exit", (code, signal) => onExit(child, name, code, signal));
    child.on("error", () => onExit(child, name, 1, null));
  };
  attachExitHandlers(convex, "Convex");

  const publish = options.publish ?? (() => publishConvexDeployment(process.cwd()));
  const trust = options.ensureTrust ?? ensureLocalTrust;
  const deploymentEnv = options.deploymentEnv ?? {
    get(name: string) {
      const result = spawnSync("bunx", ["convex", "env", "get", name], { encoding: "utf8", env: convexEnv });
      if (result.status !== 0) return null;
      const value = result.stdout.trim();
      return value || null;
    },
    set(name: string, value: string) {
      const result = spawnSync("bunx", ["convex", "env", "set", name, value], { encoding: "utf8", env: convexEnv });
      return result.status === 0;
    },
  } satisfies DeploymentEnv;
  let registered = false;
  let trusted = false;
  let bootstrapped = false;
  const deadline = Date.now() + 180_000;

  const startGateway = (): void => {
    if (gateway || stopping) return;
    gateway = spawnChild("bun", ["src/platform/gateway/server.ts", ...(options.gatewayArgs ?? [])], { stdio: "inherit" });
    children.push(gateway);
    attachExitHandlers(gateway, "gateway");
  };

  const bootstrap = (): void => {
    if (stopping || bootstrapped) return;
    try {
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
    } catch (error) {
      console.error(`anorvis: local gateway bootstrap retry: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (registered && trusted) {
      try {
        startGateway();
        bootstrapped = true;
        clearBootstrapTimer();
      } catch (error) {
        finish(1, `gateway failed to start: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (Date.now() > deadline) finish(1, "local gateway bootstrap timed out");
  };

  bootstrap();
  if (!stopping && !bootstrapped) {
    timer = (options.setInterval ?? globalThis.setInterval)(bootstrap, 2_000);
    if (bootstrapped || stopping) clearBootstrapTimer();
    if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref();
  }

  const stop = (signal: NodeJS.Signals = "SIGTERM"): void => {
    if (stopping) return;
    stopping = true;
    exitCode = 0;
    clearBootstrapTimer();
    for (const child of children) {
      try {
        child.kill(signal);
      } catch {
        // A child that already exited needs no further signal.
      }
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop(signal));

  return { convex, get gateway() { return gateway; }, stop };
}

if (import.meta.main) startDevSupervisor();
