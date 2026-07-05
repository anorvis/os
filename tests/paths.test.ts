import { describe, expect, test } from "bun:test";
import {
  ANORVIS_STORAGE_POLICIES,
  getLlmWikiRoot,
  getLogsRoot,
  getMemoryRoot,
  getTmpRoot,
} from "../src/paths";

describe("Anorvis storage paths", () => {
  test("classifies only current roots plus legacy memory", () => {
    expect(ANORVIS_STORAGE_POLICIES.os).toBe("runtime");
    expect(ANORVIS_STORAGE_POLICIES.memory).toBe("legacy");
    expect(ANORVIS_STORAGE_POLICIES["llm-wiki"]).toBe("memory");
    expect(ANORVIS_STORAGE_POLICIES.logs).toBe("log");
  });

  test("resolves active roots under .anorvis", () => {
    expect(getMemoryRoot()).toEndWith("/.anorvis/memory");
    expect(getLlmWikiRoot()).toEndWith("/.anorvis/llm-wiki");
    expect(getLogsRoot()).toEndWith("/.anorvis/logs");
    expect(getTmpRoot()).toEndWith("/.anorvis/tmp");
  });
});
