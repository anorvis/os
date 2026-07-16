import { describe, expect, test } from "bun:test";
import { ContextGatewayRuntime, type ContextGatewayRuntimeParts } from "../../src/capability/context/gateway-runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("context gateway runtime lifecycle", () => {
  test("keeps the adapter alive until deferred outbound delivery drains", async () => {
    const order: string[] = [];
    let adapterAlive = false;
    const releaseDrain = deferred<void>();
    const parts: ContextGatewayRuntimeParts = {
      discord: {
        start: () => {
          order.push("discord:start");
          adapterAlive = true;
          return Promise.resolve();
        },
        stop: () => {
          order.push("discord:stop");
          adapterAlive = false;
          return Promise.resolve();
        },
        stopInbound: () => {
          order.push("discord:stop-inbound");
          return Promise.resolve();
        },
        stopAdapter: () => {
          order.push("discord:stop-adapter");
          adapterAlive = false;
          return Promise.resolve();
        },
      },
      monitor: {
        start: () => {
          order.push("monitor:start");
          return Promise.resolve();
        },
        stop: () => {
          order.push("monitor:stop");
          return Promise.resolve();
        },
      },
      outbound: {
        start: () => {
          order.push("outbound:start");
          return Promise.resolve();
        },
        drain: async () => {
          order.push("outbound:drain");
          expect(adapterAlive).toBe(true);
          await releaseDrain.promise;
          order.push("outbound:drained");
        },
        stop: () => {
          order.push("outbound:stop");
          return Promise.resolve();
        },
      },
    };
    const runtime = new ContextGatewayRuntime(parts);

    await runtime.start();
    const stopping = runtime.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toContain("monitor:stop");
    expect(order).toContain("discord:stop-inbound");
    expect(order).toContain("outbound:drain");
    expect(order).not.toContain("discord:stop-adapter");
    expect(adapterAlive).toBe(true);

    releaseDrain.resolve(undefined);
    await stopping;
    expect(order.indexOf("discord:stop-inbound")).toBeLessThan(order.indexOf("outbound:drain"));
    expect(order.indexOf("outbound:drained")).toBeLessThan(order.indexOf("outbound:stop"));
    expect(order.indexOf("outbound:stop")).toBeLessThan(order.indexOf("discord:stop-adapter"));
    expect(adapterAlive).toBe(false);
  });

  test("supports a clean restart after an ordered stop", async () => {
    const order: string[] = [];
    let starts = 0;
    let stops = 0;
    const parts: ContextGatewayRuntimeParts = {
      discord: {
        start: () => {
          starts += 1;
          order.push(`discord:start:${starts}`);
          return Promise.resolve();
        },
        stop: () => {
          order.push(`discord:stop:${stops}`);
          return Promise.resolve();
        },
        stopInbound: () => {
          order.push(`discord:stop-inbound:${stops + 1}`);
          return Promise.resolve();
        },
        stopAdapter: () => {
          stops += 1;
          order.push(`discord:stop-adapter:${stops}`);
          return Promise.resolve();
        },
      },
      monitor: {
        start: () => {
          order.push(`monitor:start:${starts}`);
          return Promise.resolve();
        },
        stop: () => {
          order.push(`monitor:stop:${stops + 1}`);
          return Promise.resolve();
        },
      },
      outbound: {
        start: () => {
          order.push(`outbound:start:${starts}`);
          return Promise.resolve();
        },
        drain: () => {
          order.push(`outbound:drain:${stops + 1}`);
          return Promise.resolve();
        },
        stop: () => {
          order.push(`outbound:stop:${stops + 1}`);
          return Promise.resolve();
        },
      },
    };
    const runtime = new ContextGatewayRuntime(parts);
    await runtime.start();
    await runtime.stop();
    await runtime.start();
    await runtime.stop();

    expect(starts).toBe(2);
    expect(stops).toBe(2);
    expect(order.filter((entry) => entry.startsWith("outbound:drain"))).toHaveLength(2);
    expect(order.indexOf("outbound:stop:1")).toBeLessThan(order.indexOf("discord:stop-adapter:1"));
    expect(order.indexOf("outbound:stop:2")).toBeLessThan(order.indexOf("discord:stop-adapter:2"));
  });
  test("cleans up a failed startup through the same drain-before-adapter order", async () => {
    const order: string[] = [];
    let adapterAlive = false;
    const releaseDrain = deferred<void>();
    const parts: ContextGatewayRuntimeParts = {
      discord: {
        start: () => {
          adapterAlive = true;
          order.push("discord:start");
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
        stopInbound: () => {
          order.push("discord:stop-inbound");
          return Promise.resolve();
        },
        stopAdapter: () => {
          order.push("discord:stop-adapter");
          adapterAlive = false;
          return Promise.resolve();
        },
      },
      monitor: {
        start: () => Promise.resolve(),
        stop: () => {
          order.push("monitor:stop");
          return Promise.resolve();
        },
      },
      outbound: {
        start: () => Promise.reject(new Error("outbound startup failed")),
        drain: async () => {
          order.push("outbound:drain");
          expect(adapterAlive).toBe(true);
          await releaseDrain.promise;
        },
        stop: () => {
          order.push("outbound:stop");
          return Promise.resolve();
        },
      },
    };
    const runtime = new ContextGatewayRuntime(parts);
    const starting = runtime.start();
    for (let i = 0; i < 10 && !order.includes("outbound:drain"); i += 1) {
      await Promise.resolve();
    }
    expect(order).toContain("outbound:drain");
    expect(adapterAlive).toBe(true);
    releaseDrain.resolve(undefined);
    let startupError: unknown;
    try {
      await starting;
    } catch (error) {
      startupError = error;
    }
    expect(startupError).toMatchObject({ message: "outbound startup failed" });
    expect(order.indexOf("outbound:drain")).toBeLessThan(order.indexOf("outbound:stop"));
    expect(order.indexOf("outbound:stop")).toBeLessThan(order.indexOf("discord:stop-adapter"));
    expect(adapterAlive).toBe(false);
  });
  test("surfaces teardown failures after draining and destroying later phases", async () => {
    const order: string[] = [];
    const teardownError = new Error("monitor teardown failed");
    const parts: ContextGatewayRuntimeParts = {
      discord: {
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        stopInbound: () => {
          order.push("discord:stop-inbound");
          return Promise.resolve();
        },
        stopAdapter: () => {
          order.push("discord:stop-adapter");
          return Promise.resolve();
        },
      },
      monitor: {
        start: () => Promise.resolve(),
        stop: () => Promise.reject(teardownError),
      },
      outbound: {
        start: () => Promise.resolve(),
        drain: () => {
          order.push("outbound:drain");
          return Promise.resolve();
        },
        stop: () => {
          order.push("outbound:stop");
          return Promise.resolve();
        },
      },
    };
    const runtime = new ContextGatewayRuntime(parts);
    await runtime.start();
    let stopError: unknown;
    try {
      await runtime.stop();
    } catch (error) {
      stopError = error;
    }
    expect(stopError).toBe(teardownError);
    expect(order).toEqual([
      "discord:stop-inbound",
      "outbound:drain",
      "outbound:stop",
      "discord:stop-adapter",
    ]);
  });
  test("does not restart while a failed teardown still owns resources", async () => {
    const teardownError = new Error("monitor teardown failed");
    let starts = 0;
    let stopAttempts = 0;
    const runtime = new ContextGatewayRuntime({
      monitor: {
        start: () => {
          starts += 1;
          return Promise.resolve();
        },
        stop: () => {
          stopAttempts += 1;
          return Promise.reject(teardownError);
        },
      },
    });

    await runtime.start();
    let stopError: unknown;
    try {
      await runtime.stop();
    } catch (error) {
      stopError = error;
    }
    let restartError: unknown;
    try {
      await runtime.start();
    } catch (error) {
      restartError = error;
    }
    expect(stopError).toBe(teardownError);
    expect(restartError).toBe(teardownError);
    expect(starts).toBe(1);
    expect(stopAttempts).toBe(2);
  });
});
