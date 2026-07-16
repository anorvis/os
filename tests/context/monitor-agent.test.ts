import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildMonitorPrompt,
  normalizeMonitorOutput,
  runMonitorAgent,
  type MonitorInput,
} from "../../src/capability/context/monitor-agent";
import type { ContextEventInput } from "../../src/capability/context/schema";

function event(overrides: Partial<ContextEventInput> = {}): ContextEventInput {
  return {
    id: "event-1",
    kind: "conversation_turn",
    occurredAt: 1,
    source: {
      surface: "discord",
      conversationId: "conversation-1",
      visibility: "shared",
      workspaceId: "workspace-1",
      channelId: "channel-1",
    },
    content: { text: "A durable preference was discussed." },
    ...overrides,
  };
}

function input(events: readonly ContextEventInput[] = [event()]): MonitorInput {
  return { events, priorNotes: "Earlier compact context." };
}

describe("Monitor prompt contract", () => {
  test("requires privacy-aware curation and forbids private Maintainer actions", () => {
    const prompt = buildMonitorPrompt({ events: [event()], priorNotes: "Prior note." });
    expect(prompt).toContain("durable knowledge from transient activity");
    expect(prompt).toContain("Private events may only be represented in private summaries");
    expect(prompt).toContain("shared summary must include the channelId");
    expect(prompt).toContain("Do not perform or propose repair, GitHub, PR, issue, code-change, or Maintainer actions");
    expect(prompt).toContain('"summaries"');
  });
});

describe("Monitor output normalization", () => {
  test("keeps the contract fields and strips unknown fields", async () => {
    const result = await runMonitorAgent(input(), {
      monitorAgent: async () => ({
        summaries: [{ conversationId: "conversation-1", visibility: "shared", channelId: "channel-1", summary: "Useful summary", extra: "drop" }],
        wikiTasks: [{ task: "Curate durable preference", extra: true }],
        notifications: [{ text: "A timely update.", reason: "It affects the owner today.", extra: "drop" }],
        notes: "Compact note",
        unknown: "drop",
      }),
    });
    expect(result).toEqual({
      summaries: [{ conversationId: "conversation-1", visibility: "shared", channelId: "channel-1", summary: "Useful summary" }],
      wikiTasks: [{ task: "Curate durable preference" }],
      notifications: [{ text: "A timely update.", reason: "It affects the owner today." }],
      notes: "Compact note",
    });
  });

  test("returns a useful status instead of throwing for malformed output", async () => {
    const result = await runMonitorAgent(input(), { monitorAgent: async () => ({ summaries: [] }) });
    expect(result.summaries).toEqual([]);
    expect(result.notes).toContain("invalid result shape");
  });

  test("bounds counts and text lengths", () => {
    const result = normalizeMonitorOutput({
      summaries: Array.from({ length: 100 }, (_, index) => ({
        conversationId: "conversation-1",
        visibility: "shared",
        channelId: "channel-1",
        summary: "s".repeat(10_000) + index,
      })),
      wikiTasks: Array.from({ length: 100 }, () => ({ task: "w".repeat(10_000) })),
      notifications: Array.from({ length: 100 }, () => ({ text: "t".repeat(10_000), reason: "r".repeat(10_000) })),
      notes: "n".repeat(20_000),
    });
    expect(result.summaries).toHaveLength(32);
    expect(result.wikiTasks).toHaveLength(16);
    expect(result.notifications).toHaveLength(16);
    expect(result.summaries[0]?.summary).toHaveLength(2_000);
    expect(result.wikiTasks[0]?.task).toHaveLength(800);
    expect(result.notifications[0]?.text).toHaveLength(1_000);
    expect(result.notifications[0]?.reason).toHaveLength(600);
    expect(result.notes).toHaveLength(8_000);
  });

  test("rejects summaries that cross a conversation or channel scope", async () => {
    const result = await runMonitorAgent(input(), {
      monitorAgent: async () => ({
        summaries: [
          { conversationId: "conversation-1", visibility: "shared", summary: "Missing channel" },
          { conversationId: "other", visibility: "shared", channelId: "channel-1", summary: "Unknown conversation" },
          { conversationId: "conversation-1", visibility: "shared", channelId: "other-channel", summary: "Wrong channel" },
          { conversationId: "conversation-1", visibility: "shared", channelId: "channel-1", summary: "Allowed" },
        ],
        wikiTasks: [],
        notifications: [],
        notes: "",
      }),
    });
    expect(result.summaries).toEqual([{ conversationId: "conversation-1", visibility: "shared", channelId: "channel-1", summary: "Allowed" }]);
  });
  test("does not elevate private context into shared summaries", async () => {
    const result = await runMonitorAgent(input([event({
      source: { ...event().source, visibility: "private", channelId: undefined },
    })]), {
      monitorAgent: async () => ({
        summaries: [{ conversationId: "conversation-1", visibility: "shared", channelId: "channel-1", summary: "Private detail" }],
        wikiTasks: [],
        notifications: [],
        notes: "",
      }),
    });
    expect(result.summaries).toEqual([]);
  });

  test("does not invoke the agent for an empty batch", async () => {
    let called = false;
    const result = await runMonitorAgent({ events: [] }, {
      monitorAgent: async () => {
        called = true;
        return { summaries: [], wikiTasks: [], notifications: [], notes: "" };
      },
    });
    expect(called).toBe(false);
    expect(result).toEqual({ summaries: [], wikiTasks: [], notifications: [], notes: "No context events or prior notes to curate." });
  });
});

describe("Monitor OMP runner", () => {
  test("passes no-tool flags and configured model/thinking", async () => {
    const root = mkdtempSync(join(tmpdir(), "anorvis-monitor-"));
    const command = join(root, "capture-omp.js");
    const argsPath = join(root, "args.json");
    const settingsPath = join(root, "agents.json");
    writeFileSync(command, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.ANORVIS_TEST_ARGS_PATH, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({summaries:[],wikiTasks:[],notifications:[],notes:""}));\n`);
    chmodSync(command, 0o755);
    writeFileSync(settingsPath, JSON.stringify({ monitorModel: "openai-codex/gpt-5.6-sol", monitorThinking: "high" }));
    try {
      const result = await runMonitorAgent(input(), {
        command,
        cwd: root,
        env: {
          ANORVIS_AGENT_SETTINGS_PATH: settingsPath,
          ANORVIS_TEST_ARGS_PATH: argsPath,
        },
      });
      const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
      expect(result).toEqual({ summaries: [], wikiTasks: [], notifications: [], notes: "" });
      for (const flag of ["--mode", "json", "--print", "--no-session", "--no-extensions", "--no-skills", "--no-builtin-tools"]) expect(args).toContain(flag);
      expect(args).toContain("--model");
      expect(args).toContain("openai-codex/gpt-5.6-sol");
      expect(args).toContain("--thinking");
      expect(args).toContain("high");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
