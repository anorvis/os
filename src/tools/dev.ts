// Runs the local Convex backend, publishes its actual ports to the
// machine-local registry, and converges the local-trust secrets so clients
// can discover the deployment and sign in silently.
import { spawn, spawnSync } from "node:child_process";
import { publishConvexDeployment } from "../platform/convex/registry";
import { ensureLocalTrust, type DeploymentEnv } from "../platform/convex/secrets";

const child = spawn("bunx", ["convex", "dev", ...Bun.argv.slice(2)], {
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 1));

const deploymentEnv: DeploymentEnv = {
  get(name) {
    const result = spawnSync("bunx", ["convex", "env", "get", name], {
      encoding: "utf8",
    });
    if (result.status !== 0) return null;
    const value = result.stdout.trim();
    return value || null;
  },
  set(name, value) {
    const result = spawnSync("bunx", ["convex", "env", "set", name, value], {
      encoding: "utf8",
    });
    return result.status === 0;
  },
};

const deadline = Date.now() + 180_000;
let registered = false;
let trusted = false;
const bootstrap = setInterval(() => {
  if (!registered) {
    const published = publishConvexDeployment(process.cwd());
    if (published !== null) {
      console.error(`anorvis: Convex deployment registered at ${published.url}`);
      registered = true;
    }
  }
  if (registered && !trusted && ensureLocalTrust(deploymentEnv)) {
    console.error("anorvis: local trust keys are in place");
    trusted = true;
  }
  if ((registered && trusted) || Date.now() > deadline) clearInterval(bootstrap);
}, 2_000);
bootstrap.unref();
