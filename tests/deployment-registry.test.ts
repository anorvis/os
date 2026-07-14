import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishConvexDeployment,
  readConvexDeploymentPorts,
} from "../src/platform/convex/registry";

function projectWithDeployment(ports: unknown, name = "default"): string {
  const root = mkdtempSync(join(tmpdir(), "anorvis-registry-"));
  const deployment = join(root, ".convex", "local", name);
  mkdirSync(deployment, { recursive: true });
  writeFileSync(join(deployment, "config.json"), JSON.stringify({ ports }));
  return root;
}

describe("Convex deployment registry", () => {
  test("publishes the deployment's actual ports, not fixed defaults", () => {
    const root = projectWithDeployment({ cloud: 41210, site: 41211 });
    const registryPath = join(root, "registry.json");

    const published = publishConvexDeployment(root, registryPath);
    expect(published).toMatchObject({
      url: "http://127.0.0.1:41210",
      siteUrl: "http://127.0.0.1:41211",
      projectRoot: root,
    });
    const written: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(written).toMatchObject({ url: "http://127.0.0.1:41210" });
  });

  test("returns nothing before the backend has written its config", () => {
    const root = mkdtempSync(join(tmpdir(), "anorvis-registry-empty-"));
    expect(readConvexDeploymentPorts(root)).toBeNull();
    expect(publishConvexDeployment(root, join(root, "registry.json"))).toBeNull();
  });

  test("ignores malformed deployment configs", () => {
    const root = projectWithDeployment({ cloud: "not-a-port", site: 41211 });
    expect(readConvexDeploymentPorts(root)).toBeNull();
  });
});
