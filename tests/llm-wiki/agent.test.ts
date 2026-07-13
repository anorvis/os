import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { lintLlmWiki, recordInteractionMemory, runWikiAgent } from "../../src/llm-wiki";
import { resolveAgentModel, resolveAgentThinking } from "../../src/core/config/agent-settings";
import { resolveWikiAgentCommand } from "../../src/llm-wiki/agent";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "anorvis-agent-"));
}

describe("resolveWikiAgentCommand", () => {
  test("honors explicit command environment variables before host CLI discovery", () => {
    const cases = [
      {
        env: { ANORVIS_AGENT_COMMAND: "omp", ANORVIS_OMP_COMMAND: "custom-omp", ANORVIS_PI_COMMAND: "custom-pi" },
        expected: { command: "omp", label: "omp Wiki Agent" },
      },
      {
        env: { ANORVIS_OMP_COMMAND: "custom-omp", ANORVIS_PI_COMMAND: "custom-pi" },
        expected: { command: "custom-omp", label: "custom-omp Wiki Agent" },
      },
      {
        env: { ANORVIS_PI_COMMAND: "custom-pi" },
        expected: { command: "custom-pi", label: "custom-pi Wiki Agent" },
      },
    ];

    for (const { env, expected } of cases) {
      expect(resolveWikiAgentCommand(env, () => true)).toEqual(expected);
    }
  });

  test("falls back through host CLIs while preserving Pi compatibility", () => {
    const cases: Array<{
      available: Record<string, true>;
      expected: { command: string; label: string };
    }> = [
      {
        available: { pi: true, omp: true },
        expected: { command: "pi", label: "Pi Wiki Agent" },
      },
      {
        available: { omp: true },
        expected: { command: "omp", label: "OMP Wiki Agent" },
      },
      {
        available: {},
        expected: { command: "pi", label: "Pi Wiki Agent" },
      },
    ];

    for (const { available, expected } of cases) {
      expect(resolveWikiAgentCommand({}, (command) => available[command] === true)).toEqual(expected);
    }
  });
});

describe("Wiki Agent model settings", () => {
  test("reads a changed shared model setting on every invocation", () => {
    const root = tmpRoot();
    const path = join(root, "agents.json");
    const env = { ANORVIS_AGENT_SETTINGS_PATH: path };
    try {
      writeFileSync(path, JSON.stringify({
        wikiModel: "openai-codex/gpt-5.6-sol",
        wikiThinking: "high",
      }));
      expect(resolveAgentModel("wiki", env)).toBe("openai-codex/gpt-5.6-sol");
      expect(resolveAgentThinking("wiki", env)).toBe("high");

      writeFileSync(path, JSON.stringify({ wikiModel: "anthropic/claude-sonnet-4-5" }));
      expect(resolveAgentModel("wiki", env)).toBe(
        "anthropic/claude-sonnet-4-5",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runWikiAgent", () => {
  test("passes saved model and reasoning to the Wiki Agent CLI", async () => {
    const rootDir = tmpRoot();
    const command = join(rootDir, "capture-wiki-agent.js");
    const argsPath = join(rootDir, "args.json");
    const settingsPath = join(rootDir, "agents.json");
    writeFileSync(
      command,
      `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ANORVIS_TEST_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({
  answer: "Captured.",
  confidence: "high",
  sources: [],
  changed: []
}));
`,
    );
    chmodSync(command, 0o755);
    writeFileSync(
      settingsPath,
      JSON.stringify({
        wikiModel: "openai-codex/gpt-5.6-sol",
        wikiThinking: "xhigh",
      }),
    );
    const previousCommand = process.env.ANORVIS_AGENT_COMMAND;
    const previousSettings = process.env.ANORVIS_AGENT_SETTINGS_PATH;
    const previousArgsPath = process.env.ANORVIS_TEST_ARGS_PATH;
    process.env.ANORVIS_AGENT_COMMAND = command;
    process.env.ANORVIS_AGENT_SETTINGS_PATH = settingsPath;
    process.env.ANORVIS_TEST_ARGS_PATH = argsPath;
    try {
      const result = await runWikiAgent(
        { task: "Capture model arguments." },
        { rootDir },
      );
      const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
      const modelIndex = args.indexOf("--model");
      const thinkingIndex = args.indexOf("--thinking");

      expect(result.answer).toBe("Captured.");
      expect(args[modelIndex + 1]).toBe("openai-codex/gpt-5.6-sol");
      expect(args[thinkingIndex + 1]).toBe("xhigh");
    } finally {
      if (previousCommand === undefined)
        delete process.env.ANORVIS_AGENT_COMMAND;
      else process.env.ANORVIS_AGENT_COMMAND = previousCommand;
      if (previousSettings === undefined)
        delete process.env.ANORVIS_AGENT_SETTINGS_PATH;
      else process.env.ANORVIS_AGENT_SETTINGS_PATH = previousSettings;
      if (previousArgsPath === undefined)
        delete process.env.ANORVIS_TEST_ARGS_PATH;
      else process.env.ANORVIS_TEST_ARGS_PATH = previousArgsPath;
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("delegates normal wiki tasks to the Pi Wiki Agent runner", async () => {
    const rootDir = tmpRoot();
    let called = false;
    const result = await runWikiAgent({ task: "Remember that Anorvis uses llm-wiki." }, {
      rootDir,
      now: new Date("2026-07-03T00:00:00.000Z"),
      wikiAgent: ({ task, rootDir: agentRoot }) => {
        called = true;
        expect(task).toBe("Remember that Anorvis uses llm-wiki.");
        expect(agentRoot).toBe(rootDir);
        const page = "wiki/queries/2026-07-03-anorvis-uses-llm-wiki.md";
        mkdirSync(join(rootDir, "wiki", "queries"), { recursive: true });
        writeFileSync(join(rootDir, page), "---\ntype: query\ntitle: Anorvis uses llm-wiki\ncreated: 2026-07-03\nupdated: 2026-07-03\nstatus: seed\ntags: []\nrelated: []\nsources: []\n---\n\n# Anorvis uses llm-wiki\n");
        return Promise.resolve({
          task,
          answer: "Recorded by Pi Wiki Agent.",
          confidence: "high",
          sources: [{ path: page, title: "Anorvis uses llm-wiki" }],
          changed: [{ path: page, action: "created", why: "Pi Wiki Agent wrote it." }],
          readNext: [{ path: page, reason: "Review result." }],
          contradictions: [],
          gaps: [],
          warnings: [],
        });
      },
    });

    expect(called).toBe(true);
    expect(result.answer).toContain("Pi Wiki Agent");
    expect(result.changed.some((c) => c.path.startsWith("wiki/queries/"))).toBe(true);
    expect(readFileSync(join(rootDir, "log.md"), "utf8")).toContain("Wiki Agent handled");
    expect((await lintLlmWiki({ rootDir })).ok).toBe(true);
  });

  test("scopes vault tasks to an added vault", async () => {
    const rootDir = tmpRoot();
    const vaultDir = tmpRoot();
    mkdirSync(join(rootDir, ".index"), { recursive: true });
    writeFileSync(join(rootDir, ".index", "vaults.json"), JSON.stringify({ vaults: [{ name: "Work", path: vaultDir }] }));

    let cwd = "";
    const result = await runWikiAgent({ task: "What is in this vault?", vault: "Work" }, {
      rootDir,
      now: new Date("2026-07-03T00:01:00.000Z"),
      wikiAgent: ({ vault }) => {
        cwd = vault?.path ?? "";
        return Promise.resolve({
          task: "What is in this vault?",
          answer: "Inspected selected vault only.",
          confidence: "high",
          sources: [{ path: "Note.md", title: "Note" }],
          changed: [],
          readNext: [],
          contradictions: [],
          gaps: [],
          warnings: [],
        });
      },
    });

    expect(cwd).toBe(realpathSync(vaultDir));
    expect(result.answer).toContain("selected vault");
  });

  test("recall tasks are answered by the Pi Wiki Agent runner without deterministic search", async () => {
    const rootDir = tmpRoot();
    const recalled = await runWikiAgent({ task: "What sea otter fact did we record?" }, {
      rootDir,
      now: new Date("2026-07-03T00:01:00.000Z"),
      wikiAgent: ({ task }) => Promise.resolve({
        task,
        answer: "Sea otters hold hands while resting so they do not drift apart.",
        confidence: "high",
        sources: [{ path: "wiki/queries/sea-otters.md", title: "Sea otters" }],
        changed: [],
        readNext: [{ path: "wiki/queries/sea-otters.md", reason: "Pi Wiki Agent inspected it." }],
        contradictions: [],
        gaps: [],
        warnings: [],
      }),
    });

    expect(recalled.answer).toContain("Sea otters hold hands");
    expect(recalled.readNext[0]?.reason).toBe("Pi Wiki Agent inspected it.");
    expect(recalled.changed).toHaveLength(0);
  });

  test("reports a timed-out agent run as unverified rather than failed, even when an orphan holds the stdio pipes", async () => {
    const rootDir = tmpRoot();
    const script = join(tmpRoot(), "slow-agent.sh");
    // The backgrounded sleep inherits the stdio pipes and outlives the killed agent,
    // so 'close' stays pending; the runner must settle from 'exit' instead of hanging.
    writeFileSync(script, "#!/bin/sh\nsleep 30 &\nexec sleep 30\n", { mode: 0o755 });
    const previous = process.env.ANORVIS_AGENT_COMMAND;
    process.env.ANORVIS_AGENT_COMMAND = script;
    try {
      const result = await runWikiAgent({ task: "Long maintenance task", dryRun: true, timeoutMs: 300 }, { rootDir });
      expect(result.confidence).toBe("low");
      expect(result.answer).toContain("timed out");
      expect(result.answer).not.toContain("failed");
      expect(result.answer).toContain("changes it made were still applied");
      expect(result.gaps.some((gap) => gap.includes("unverified"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ANORVIS_AGENT_COMMAND;
      else process.env.ANORVIS_AGENT_COMMAND = previous;
    }
  });

  test("migrates legacy memory through anorvis_wiki dry-run and approved run", async () => {
    const rootDir = tmpRoot();
    const legacyRoot = tmpRoot();
    mkdirSync(join(legacyRoot, "preference"), { recursive: true });
    writeFileSync(join(legacyRoot, "preference", "index.md"), "# Preferences\n\nUse direct names.\n");

    const dry = await runWikiAgent({ task: "migrate old memory", dryRun: true }, { rootDir, legacyRoot, now: new Date("2026-07-03T00:00:00.000Z") });
    expect(dry.changed).toHaveLength(0);

    const migrated = await runWikiAgent({ task: "migrate old memory" }, { rootDir, legacyRoot, now: new Date("2026-07-03T00:00:00.000Z") });
    expect(migrated.changed.some((c) => c.path === "wiki/sources/legacy-memory-migration.md")).toBe(true);
    expect(readdirSync(join(rootDir, "raw", "notes")).length).toBeGreaterThan(0);
    expect(readFileSync(join(legacyRoot, "preference", "index.md"), "utf8")).toContain("Use direct names");
  });
});

describe("recordInteractionMemory", () => {
  test("captures each turn as raw source and serializes wiki compiles", async () => {
    const rootDir = tmpRoot();
    let active = 0;
    let maxActive = 0;
    const seenTasks: string[] = [];

    const makeMemory = (prompt: string, turnIndex: number) => recordInteractionMemory({
      sessionId: "session/alpha",
      turnIndex,
      eventName: "turn_end",
      prompt,
      assistant: { role: "assistant", content: `Answer ${turnIndex}` },
      toolResults: [],
      interaction: { type: "turn_end", turnIndex },
      background: false,
    }, {
      rootDir,
      now: new Date(`2026-07-03T00:00:0${turnIndex}.000Z`),
      wikiAgent: async ({ task, rootDir: agentRoot }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        seenTasks.push(task);
        await Promise.resolve();
        const rawPath = task.match(/Raw source: (raw\/[^\n]+)/)?.[1] ?? "";
        const page = `wiki/preferences/interaction-${turnIndex}.md`;
        mkdirSync(join(agentRoot, "wiki", "preferences"), { recursive: true });
        writeFileSync(join(agentRoot, page), `---\ntype: preference\ntitle: Interaction ${turnIndex}\ncreated: 2026-07-03\nupdated: 2026-07-03\nstatus: seed\ntags: []\nrelated: []\nsources: [${rawPath}]\n---\n\n# Interaction ${turnIndex}\n\nCompiled durable memory from a turn.\n`);
        active -= 1;
        return {
          task,
          answer: "Compiled interaction memory.",
          confidence: "high",
          sources: [{ path: rawPath, title: "Agent Interaction" }],
          changed: [{ path: page, action: "created", why: "Captured durable turn memory." }],
          readNext: [{ path: page, reason: "Review memory." }],
          contradictions: [],
          gaps: [],
          warnings: [],
        };
      },
    });

    const [first, second] = await Promise.all([makeMemory("Remember I prefer direct answers.", 1), makeMemory("Remember I use Anorvis for planning.", 2)]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(maxActive).toBe(1);
    expect(seenTasks).toHaveLength(2);
    expect(seenTasks[0]).toContain("Remember I prefer direct answers.");
    expect(first.ok && readFileSync(join(rootDir, first.rawPath), "utf8")).toContain("Remember I prefer direct answers.");
    expect(second.ok && readFileSync(join(rootDir, second.rawPath), "utf8")).toContain("Remember I use Anorvis for planning.");
    expect((await lintLlmWiki({ rootDir })).ok).toBe(true);
  });


  test("redacts prompt secrets before writing raw memory", async () => {
    const rootDir = tmpRoot();
    const secret = "hevy_secret_value_12345";
    const result = await recordInteractionMemory({
      sessionId: "redaction-session",
      prompt: `Please remember apiKey: ${secret}`,
      assistant: "ok",
      background: false,
    }, {
      rootDir,
      wikiAgent: ({ task }) => Promise.resolve({
        task,
        answer: "No durable memory.",
        confidence: "medium",
        sources: [],
        changed: [],
        readNext: [],
        contradictions: [],
        gaps: [],
        warnings: [],
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = readFileSync(join(rootDir, result.rawPath), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("apiKey: [REDACTED]");
  });
  test("rejects empty interactions before writing raw memory", async () => {
    const rootDir = tmpRoot();
    const result = await recordInteractionMemory({
      sessionId: "empty-session",
      background: false,
    }, {
      rootDir,
      wikiAgent: () => {
        throw new Error("wiki agent should not run for empty interaction payloads");
      },
    });

    expect(result).toEqual({ ok: false, error: "prompt, assistant, or interaction is required" });
    expect(existsSync(join(rootDir, "raw", "sessions"))).toBe(false);
  });
});
