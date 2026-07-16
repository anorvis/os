// Convex deploys "use node" actions only under Node.js 18, 20, 22, or 24.
// The operator's default `node` is often newer (or absent), which makes
// `convex dev` silently skip node-action configuration and breaks every
// integration action at runtime. Resolve a supported Node before spawning
// Convex, or fail fast with actionable guidance.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SUPPORTED_NODE_MAJORS: Record<number, true> = { 18: true, 20: true, 22: true, 24: true };
export type NodeRuntimeProbe = {
  nodeMajor?: (command: string) => number | null;
  exists?: (path: string) => boolean;
  list?: (directory: string) => string[];
  home?: () => string;
};

function detectNodeMajor(command: string): number | null {
  try {
    const result = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (result.status !== 0) return null;
    const match = result.stdout.trim().match(/^v(\d+)\./);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function listVersions(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/**
 * Return an environment for Convex CLI processes whose PATH resolves a
 * supported Node.js. The current PATH wins when it already qualifies;
 * otherwise well-known Homebrew/nvm/volta/asdf install locations are probed,
 * newest supported major first. Throws with install guidance when no
 * supported runtime exists anywhere.
 */
export function supportedConvexNodeEnv(
  base: NodeJS.ProcessEnv = process.env,
  probe: NodeRuntimeProbe = {},
): NodeJS.ProcessEnv {
  const nodeMajor = probe.nodeMajor ?? detectNodeMajor;
  const exists = probe.exists ?? existsSync;
  const list = probe.list ?? listVersions;
  const home = probe.home ?? homedir;

  const current = nodeMajor("node");
  if (current !== null && SUPPORTED_NODE_MAJORS[current]) return base;

  const candidates: string[] = [];
  for (const major of [24, 22, 20, 18]) {
    candidates.push(
      `/opt/homebrew/opt/node@${major}/bin`,
      `/usr/local/opt/node@${major}/bin`,
    );
  }
  const managerRoots = [
    join(home(), ".nvm", "versions", "node"),
    join(home(), ".volta", "tools", "image", "node"),
    join(home(), ".asdf", "installs", "nodejs"),
  ];
  for (const root of managerRoots) {
    const versions = list(root)
      .map((name) => ({
        name,
        major: Number.parseInt(name.replace(/^v/, ""), 10),
      }))
      .filter((entry) => SUPPORTED_NODE_MAJORS[entry.major])
      .sort((a, b) => b.major - a.major);
    for (const entry of versions) candidates.push(join(root, entry.name, "bin"));
  }

  for (const directory of candidates) {
    const binary = join(directory, "node");
    if (!exists(binary)) continue;
    const major = nodeMajor(binary);
    if (major !== null && SUPPORTED_NODE_MAJORS[major]) {
      return { ...base, PATH: `${directory}:${base.PATH ?? ""}` };
    }
  }

  throw new Error(
    `Convex needs Node.js 18, 20, 22, or 24 on PATH to deploy "use node" actions; ` +
      `found ${current === null ? "no node" : `v${current}`}. ` +
      "Install a supported version (e.g. `brew install node@22` or nvm) and restart.",
  );
}
