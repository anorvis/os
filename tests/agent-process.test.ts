import { describe, expect, test } from "bun:test";
import { runAgentProcess } from "../src/core/agent/process";

describe("runAgentProcess", () => {
  test("retains a final event after bounded rolling capture", async () => {
    const finalEvent = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final result" }],
      },
    });
    const result = await runAgentProcess({
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write('x'.repeat(4096));process.stdout.write(${JSON.stringify(finalEvent + "\n")});`,
      ],
      cwd: process.cwd(),
      label: "Test Agent",
      timeoutMs: 5_000,
      maxOutputBytes: 128,
    });

    expect(result.code).toBe(0);
    expect(result.outputLimited).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.stdout).toContain(finalEvent);
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(128);
  });

});
