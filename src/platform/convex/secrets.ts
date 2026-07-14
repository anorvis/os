import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Local trust bootstrap: the machine key file and the deployment env must
// agree for silent local sign-in to work, and provider credentials need an
// encryption key at rest. Whoever runs the backend converges both.
export type DeploymentEnv = {
  get(name: string): string | null;
  set(name: string, value: string): boolean;
};

export function setupKeyPath(home = process.env.HOME ?? homedir()): string {
  return join(home, ".anorvis", "convex-setup-key");
}

export function ensureLocalTrust(
  env: DeploymentEnv,
  keyPath = setupKeyPath(),
  randomKey: () => string = () => randomBytes(32).toString("base64"),
): boolean {
  return ensureSetupKey(env, keyPath, randomKey) && ensureCredentialKey(env, randomKey);
}

function ensureSetupKey(
  env: DeploymentEnv,
  keyPath: string,
  randomKey: () => string,
): boolean {
  const fromFile = readKeyFile(keyPath);
  if (fromFile !== null) {
    // The machine file is the authority clients sign in with.
    return env.get("ANORVIS_OWNER_SETUP_KEY") === fromFile
      ? true
      : env.set("ANORVIS_OWNER_SETUP_KEY", fromFile);
  }
  const fromEnv = env.get("ANORVIS_OWNER_SETUP_KEY");
  if (fromEnv !== null) {
    writeKeyFile(keyPath, fromEnv);
    return true;
  }
  const generated = randomKey();
  if (!env.set("ANORVIS_OWNER_SETUP_KEY", generated)) return false;
  writeKeyFile(keyPath, generated);
  return true;
}

function ensureCredentialKey(env: DeploymentEnv, randomKey: () => string): boolean {
  if (env.get("ANORVIS_CREDENTIAL_KEY") !== null) return true;
  return env.set("ANORVIS_CREDENTIAL_KEY", randomKey());
}

function readKeyFile(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function writeKeyFile(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
