import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalTrust, type DeploymentEnv } from "../src/platform/convex/secrets";

function fakeEnv(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const sets: Array<[string, string]> = [];
  const env: DeploymentEnv = {
    get: (name) => values.get(name) ?? null,
    set(name, value) {
      values.set(name, value);
      sets.push([name, value]);
      return true;
    },
  };
  return { env, values, sets };
}

function tempKeyPath(): string {
  return join(mkdtempSync(join(tmpdir(), "anorvis-trust-")), "convex-setup-key");
}

describe("local trust bootstrap", () => {
  test("generates and mirrors both secrets on a fresh deployment", () => {
    const { env, values } = fakeEnv();
    const keyPath = tempKeyPath();
    let counter = 0;
    const ok = ensureLocalTrust(env, keyPath, () => `generated-${++counter}`);

    expect(ok).toBe(true);
    expect(readFileSync(keyPath, "utf8").trim()).toBe("generated-1");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(values.get("ANORVIS_OWNER_SETUP_KEY")).toBe("generated-1");
    expect(values.get("ANORVIS_CREDENTIAL_KEY")).toBe("generated-2");
  });

  test("the machine key file wins over a diverged deployment env", () => {
    const { env, sets } = fakeEnv({
      ANORVIS_OWNER_SETUP_KEY: "stale",
      ANORVIS_CREDENTIAL_KEY: "existing",
    });
    const keyPath = tempKeyPath();
    writeFileSync(keyPath, "machine-key\n");

    expect(ensureLocalTrust(env, keyPath, () => "unused")).toBe(true);
    expect(sets).toEqual([["ANORVIS_OWNER_SETUP_KEY", "machine-key"]]);
  });

  test("recovers a missing key file from the deployment env", () => {
    const { env, sets } = fakeEnv({
      ANORVIS_OWNER_SETUP_KEY: "deployed-key",
      ANORVIS_CREDENTIAL_KEY: "existing",
    });
    const keyPath = tempKeyPath();

    expect(ensureLocalTrust(env, keyPath, () => "unused")).toBe(true);
    expect(readFileSync(keyPath, "utf8").trim()).toBe("deployed-key");
    expect(sets).toEqual([]);
  });

  test("converged state is a no-op", () => {
    const { env, sets } = fakeEnv({
      ANORVIS_OWNER_SETUP_KEY: "machine-key",
      ANORVIS_CREDENTIAL_KEY: "existing",
    });
    const keyPath = tempKeyPath();
    writeFileSync(keyPath, "machine-key\n");

    expect(ensureLocalTrust(env, keyPath, () => "unused")).toBe(true);
    expect(sets).toEqual([]);
  });
});
