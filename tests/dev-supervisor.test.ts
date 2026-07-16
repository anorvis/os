import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { startDevSupervisor, type DevSpawn } from "../src/tools/dev";

class FakeChild {
  readonly kills: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, listener: (...args: unknown[]) => void): this {
    const callbacks = this.listeners.get(event) ?? [];
    callbacks.push(listener);
    this.listeners.set(event, callbacks);
    return this;
  }
  kill(signal: string): boolean {
    this.kills.push(signal);
    return true;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

describe("dev supervisor", () => {
  test("starts Convex and gateway and tears down the peer on failure", () => {
    const children: FakeChild[] = [];
    const commands: string[][] = [];
    const spawn: DevSpawn = (command: string, args: readonly string[]) => {
      commands.push([command, ...args]);
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    };
    let exitCode: number | undefined;
    const clearCalls: unknown[] = [];
    const supervisor = startDevSupervisor({
      spawn,
      publish: () => ({ url: "http://127.0.0.1:3210" }),
      ensureTrust: () => true,
      setInterval: (() => ({ unref() {} })) as unknown as typeof setInterval,
      clearInterval: ((timer: unknown) => clearCalls.push(timer)) as unknown as typeof clearInterval,
      exit: (code) => { exitCode = code; },
    });
    expect(commands[0]).toEqual(["bunx", "convex", "dev"]);
    expect(commands[1]).toEqual(["bun", "src/platform/gateway/server.ts"]);
    children[0]?.emit("exit", 2, null);
    expect(children[1]?.kills).toContain("SIGTERM");
    children[1]?.emit("exit", null, "SIGTERM");
    expect(exitCode).toBe(2);
    expect(clearCalls.length).toBe(0);
    supervisor.stop();
  });
  test("waits for deployment registration and trust before starting gateway", () => {
    const children: FakeChild[] = [];
    const commands: string[][] = [];
    const callbacks: Array<() => void> = [];
    let registered = false;
    let trusted = false;
    const spawn: DevSpawn = (command: string, args: readonly string[]) => {
      commands.push([command, ...args]);
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    };
    const supervisor = startDevSupervisor({
      spawn,
      publish: () => registered ? { url: "http://127.0.0.1:3210" } : null,
      ensureTrust: () => {
        expect(registered).toBe(true);
        return trusted;
      },
      setInterval: ((callback: () => void) => {
        callbacks.push(callback);
        return { unref() {} };
      }) as unknown as typeof setInterval,
      exit: () => {},
    });
    expect(commands).toEqual([["bunx", "convex", "dev"]]);
    registered = true;
    trusted = true;
    callbacks[0]?.();
    expect(commands).toEqual([
      ["bunx", "convex", "dev"],
      ["bun", "src/platform/gateway/server.ts"],
    ]);
    expect(supervisor.gateway).toBe(children[1] as unknown as ChildProcess);
    supervisor.stop();
  });
});
