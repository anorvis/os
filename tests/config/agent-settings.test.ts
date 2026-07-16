import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveAgentModel, resolveAgentThinking } from "../../src/core/config/agent-settings";

describe("Monitor agent settings", () => {
  test("prefers the monitor model environment override", () => {
    const root = mkdtempSync(join(tmpdir(), "anorvis-settings-"));
    const path = join(root, "agents.json");
    try {
      writeFileSync(path, JSON.stringify({ monitorModel: "saved-model", monitorThinking: "medium" }));
      const env = { ANORVIS_AGENT_SETTINGS_PATH: path, ANORVIS_MONITOR_AGENT_MODEL: " env-model " };
      expect(resolveAgentModel("monitor", env)).toBe("env-model");
      expect(resolveAgentThinking("monitor", env)).toBe("medium");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads persisted monitor model and rejects invalid thinking values", () => {
    const root = mkdtempSync(join(tmpdir(), "anorvis-settings-"));
    const path = join(root, "agents.json");
    try {
      writeFileSync(path, JSON.stringify({ monitorModel: "saved-model", monitorThinking: "not-a-level" }));
      const env = { ANORVIS_AGENT_SETTINGS_PATH: path };
      expect(resolveAgentModel("monitor", env)).toBe("saved-model");
      expect(resolveAgentThinking("monitor", env)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
