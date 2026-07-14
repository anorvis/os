import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The local Convex backend chooses its own ports and records them in the
// project's deployment config. Publishing them to a machine-local registry
// lets the web app and extension discover the running deployment instead of
// assuming fixed ports.
export type ConvexDeployment = {
  url: string;
  siteUrl: string;
  // The project directory owning the deployment state, so a supervisor can
  // restart this exact deployment instead of provisioning an empty one.
  projectRoot: string;
  updatedAt: string;
};

export function convexDeploymentRegistryPath(home = homedir()): string {
  return join(home, ".anorvis", "convex", "deployment.json");
}

export function readConvexDeploymentPorts(
  projectRoot: string,
): { cloud: number; site: number } | null {
  const localRoot = join(projectRoot, ".convex", "local");
  let deployments: string[];
  try {
    deployments = readdirSync(localRoot);
  } catch {
    return null;
  }
  let newest: { ports: { cloud: number; site: number }; modifiedAt: number } | null = null;
  for (const name of deployments) {
    const configPath = join(localRoot, name, "config.json");
    const ports = readPorts(configPath);
    if (ports === null) continue;
    let modifiedAt = 0;
    try {
      modifiedAt = statSync(configPath).mtimeMs;
    } catch {
      continue;
    }
    if (newest === null || modifiedAt > newest.modifiedAt) {
      newest = { ports, modifiedAt };
    }
  }
  return newest?.ports ?? null;
}

export function publishConvexDeployment(
  projectRoot: string,
  registryPath = convexDeploymentRegistryPath(),
): ConvexDeployment | null {
  const ports = readConvexDeploymentPorts(projectRoot);
  if (ports === null) return null;
  const deployment: ConvexDeployment = {
    url: `http://127.0.0.1:${ports.cloud}`,
    siteUrl: `http://127.0.0.1:${ports.site}`,
    projectRoot,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify(deployment, null, 2)}\n`);
  return deployment;
}

function readPorts(configPath: string): { cloud: number; site: number } | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== "object" || !("ports" in decoded)) return null;
  const ports = decoded.ports;
  if (ports === null || typeof ports !== "object") return null;
  if (!("cloud" in ports) || typeof ports.cloud !== "number") return null;
  if (!("site" in ports) || typeof ports.site !== "number") return null;
  return { cloud: ports.cloud, site: ports.site };
}
