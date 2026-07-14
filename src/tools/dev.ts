// Runs the local Convex backend and publishes its actual ports to the
// machine-local registry so clients never depend on hardcoded defaults.
import { spawn } from "node:child_process";
import { publishConvexDeployment } from "../platform/convex/registry";

const child = spawn("bunx", ["convex", "dev", ...Bun.argv.slice(2)], {
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 1));

const deadline = Date.now() + 120_000;
const publish = setInterval(() => {
  const published = publishConvexDeployment(process.cwd());
  if (published !== null) {
    console.error(`anorvis: Convex deployment registered at ${published.url}`);
    clearInterval(publish);
    return;
  }
  if (Date.now() > deadline) clearInterval(publish);
}, 1_000);
publish.unref();
