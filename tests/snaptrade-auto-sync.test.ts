import { describe, expect, it } from "bun:test";
import {
  createSnapTradeAutoSync,
  snapTradeAutoSyncIntervalMs,
} from "../src/capability/finance/snaptrade-auto-sync";

function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

describe("createSnapTradeAutoSync tick", () => {
  it("skips without syncing when SnapTrade is not connected", async () => {
    let synced = 0;
    const loop = createSnapTradeAutoSync({
      settings: () => ({ connected: false }),
      sync: async () => {
        synced += 1;
        return { warnings: [] };
      },
      invalidate: () => {},
      log: () => {},
    });

    expect(await loop.tick()).toBe("skipped-disconnected");
    expect(synced).toBe(0);
  });

  it("syncs and emits a finance invalidation when connected", async () => {
    const calls: string[] = [];
    const loop = createSnapTradeAutoSync({
      settings: () => ({ connected: true }),
      sync: async () => {
        calls.push("sync");
        return { warnings: ["one balance skipped"] };
      },
      invalidate: () => calls.push("invalidate"),
      log: (message) => calls.push(message),
    });

    expect(await loop.tick()).toBe("synced");
    expect(calls).toEqual([
      "sync",
      "invalidate",
      "snaptrade auto-sync ok · warnings: one balance skipped",
    ]);
  });

  it("refuses to overlap an in-flight sync", async () => {
    const gate = deferred<void>();
    let started = 0;
    const loop = createSnapTradeAutoSync({
      settings: () => ({ connected: true }),
      sync: async () => {
        started += 1;
        await gate.promise;
        return { warnings: [] };
      },
      invalidate: () => {},
      log: () => {},
    });

    const first = loop.tick();
    expect(await loop.tick()).toBe("skipped-inflight");
    gate.resolve();
    expect(await first).toBe("synced");
    expect(started).toBe(1);

    // Guard releases after settle: the next tick syncs again.
    expect(await loop.tick()).toBe("synced");
  });

  it("contains sync failures without emitting an invalidation", async () => {
    const logs: string[] = [];
    let invalidated = 0;
    const loop = createSnapTradeAutoSync({
      settings: () => ({ connected: true }),
      sync: async () => {
        throw new Error("upstream 429");
      },
      invalidate: () => {
        invalidated += 1;
      },
      log: (message) => logs.push(message),
    });

    expect(await loop.tick()).toBe("failed");
    expect(invalidated).toBe(0);
    expect(logs).toEqual(["snaptrade auto-sync failed: upstream 429"]);
  });
});

describe("snapTradeAutoSyncIntervalMs", () => {
  it("defaults to hourly, disables on zero, and clamps tiny intervals", () => {
    expect(snapTradeAutoSyncIntervalMs({})).toBe(3_600_000);
    expect(
      snapTradeAutoSyncIntervalMs({ ANORVIS_SNAPTRADE_SYNC_INTERVAL_MS: "" }),
    ).toBe(3_600_000);
    expect(
      snapTradeAutoSyncIntervalMs({
        ANORVIS_SNAPTRADE_SYNC_INTERVAL_MS: "not-a-number",
      }),
    ).toBe(3_600_000);
    expect(
      snapTradeAutoSyncIntervalMs({ ANORVIS_SNAPTRADE_SYNC_INTERVAL_MS: "0" }),
    ).toBe(0);
    expect(
      snapTradeAutoSyncIntervalMs({
        ANORVIS_SNAPTRADE_SYNC_INTERVAL_MS: "1000",
      }),
    ).toBe(300_000);
    expect(
      snapTradeAutoSyncIntervalMs({
        ANORVIS_SNAPTRADE_SYNC_INTERVAL_MS: "7200000",
      }),
    ).toBe(7_200_000);
  });
});
