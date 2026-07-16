import { ConvexError } from "convex/values";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConvexContextClient,
  type ContextAppendRequest,
  writeConvexSession,
} from "../../src/capability/context/client";

type ActionPayload = Record<string, unknown>;
type ActionResult = ActionPayload | Error | (() => Promise<ActionPayload>);

type FakeTransport = {
  actions: Array<Record<string, unknown>>;
  mutations: number;
  authTokens: string[];
  actionResults: ActionResult[];
  mutationResults: Array<ActionPayload | Error>;
  query: (reference: unknown, args: Record<string, unknown>) => Promise<unknown>;
  mutation: (reference: unknown, args: Record<string, unknown>) => Promise<unknown>;
  action: (reference: unknown, args: Record<string, unknown>) => Promise<unknown>;
  setAuth: (token: string) => void;
};

function fakeTransport(actionResults: ActionResult[] = [], mutationResults: Array<ActionPayload | Error> = []): FakeTransport {
  const transport: FakeTransport = {
    actions: [],
    mutations: 0,
    authTokens: [],
    actionResults,
    mutationResults,
    query() {
      return Promise.resolve({ events: [], summaries: [], wikiPages: [] });
    },
    mutation() {
      transport.mutations += 1;
      const result = transport.mutationResults.shift();
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result ?? { id: "event-1", inserted: true });
    },
    async action(_reference, args) {
      transport.actions.push(args);
      const result = transport.actionResults.shift();
      if (result instanceof Error) throw result;
      if (typeof result === "function") return result();
      return result ?? {};
    },
    setAuth(token) {
      transport.authTokens.push(token);
    },
  };
  return transport;
}

function token(expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1_000) }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

function appendInput(): ContextAppendRequest {
  return {
    id: "event-1",
    kind: "conversation_turn",
    occurredAt: 1,
    source: { surface: "pi", conversationId: "conversation-1", visibility: "private" },
    content: { text: "hello" },
  };
}

async function withFakeClock<T>(run: (setNow: (value: number) => void, now: number) => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    return await run((value) => {
      now = value;
    }, now);
  } finally {
    Date.now = originalNow;
  }
}

function testPaths(): { home: string; sessionPath: string; setupKeyPath: string } {
  const home = mkdtempSync(join(tmpdir(), "anorvis-context-client-"));
  return {
    home,
    sessionPath: join(home, "session.json"),
    setupKeyPath: join(home, "setup-key"),
  };
}

describe("Convex context client authentication", () => {
  test("authenticates once before the initial invocation", async () => {
    await withFakeClock(async (_setNow, now) => {
      const paths = testPaths();
      writeFileSync(paths.setupKeyPath, "machine-key\n");
      const first = token(now + 60 * 60_000);
      const transport = fakeTransport([{ token: first, refreshToken: "refresh-1" }]);
      const client = new ConvexContextClient({ ...paths, client: transport });

      await client.append(appendInput());

      expect(transport.actions).toEqual([{ provider: "local-key", params: { key: "machine-key" } }]);
      expect(transport.mutations).toBe(1);
      expect(transport.authTokens).toEqual([first]);
    });
  });

  test("reuses a cached session before its refresh window", async () => {
    await withFakeClock(async (setNow, now) => {
      const paths = testPaths();
      const existing = token(now + 60 * 60_000);
      writeConvexSession({ token: existing, refreshToken: "refresh-1" }, paths.sessionPath);
      const transport = fakeTransport();
      const client = new ConvexContextClient({ ...paths, client: transport });

      await client.append(appendInput());
      setNow(now + 10 * 60_000);
      await client.append(appendInput());

      expect(transport.actions).toHaveLength(0);
      expect(transport.mutations).toBe(2);
      expect(transport.authTokens).toEqual([existing]);
    });
  });

  test("refreshes a cached session after its JWT expires", async () => {
    await withFakeClock(async (setNow, now) => {
      const paths = testPaths();
      const oldToken = token(now + 60 * 60_000);
      const refreshedToken = token(now + 2 * 60 * 60_000);
      writeConvexSession({ token: oldToken, refreshToken: "refresh-1" }, paths.sessionPath);
      const transport = fakeTransport([{ token: refreshedToken, refreshToken: "refresh-2" }]);
      const client = new ConvexContextClient({ ...paths, client: transport });

      await client.append(appendInput());
      setNow(now + 61 * 60_000);
      await client.append(appendInput());

      expect(transport.actions).toEqual([{ refreshToken: "refresh-1" }]);
      expect(transport.mutations).toBe(2);
      expect(transport.authTokens).toEqual([oldToken, refreshedToken]);
    });
  });

  test("deduplicates concurrent refreshes", async () => {
    await withFakeClock(async (_setNow, now) => {
      const paths = testPaths();
      const oldToken = token(now - 1_000);
      const refreshedToken = token(now + 2 * 60 * 60_000);
      writeConvexSession({ token: oldToken, refreshToken: "refresh-1" }, paths.sessionPath);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const transport = fakeTransport([
        async () => {
          started.resolve();
          await release.promise;
          return { token: refreshedToken, refreshToken: "refresh-2" };
        },
      ]);
      const client = new ConvexContextClient({ ...paths, client: transport });

      const first = client.append(appendInput());
      const second = client.append(appendInput());
      await started.promise;
      expect(transport.actions).toHaveLength(1);
      release.resolve();
      await Promise.all([first, second]);

      expect(transport.actions).toHaveLength(1);
      expect(transport.mutations).toBe(2);
    });
  });

  test("refreshes after an unauthenticated invocation and retries once", async () => {
    await withFakeClock(async (_setNow, now) => {
      const paths = testPaths();
      const oldToken = token(now + 60 * 60_000);
      const refreshedToken = token(now + 2 * 60 * 60_000);
      writeConvexSession({ token: oldToken, refreshToken: "refresh-1" }, paths.sessionPath);
      const transport = fakeTransport([{ token: refreshedToken, refreshToken: "refresh-2" }], [new Error("Unauthenticated"), { id: "event-1", inserted: true }]);
      const client = new ConvexContextClient({ ...paths, client: transport });

      await client.append(appendInput());

      expect(transport.actions).toEqual([{ refreshToken: "refresh-1" }]);
      expect(transport.mutations).toBe(2);
      expect(transport.authTokens).toEqual([oldToken, refreshedToken]);
    });
  });

  test("recognizes ConvexError authentication payloads", async () => {
    await withFakeClock(async (_setNow, now) => {
      const paths = testPaths();
      const oldToken = token(now + 60 * 60_000);
      const refreshedToken = token(now + 2 * 60 * 60_000);
      writeConvexSession({ token: oldToken, refreshToken: "refresh-1" }, paths.sessionPath);
      const transport = fakeTransport(
        [{ token: refreshedToken, refreshToken: "refresh-2" }],
        [new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in is required" }), { id: "event-1", inserted: true }],
      );
      const client = new ConvexContextClient({ ...paths, client: transport });

      await client.append(appendInput());

      expect(transport.actions).toEqual([{ refreshToken: "refresh-1" }]);
      expect(transport.mutations).toBe(2);
      expect(transport.authTokens).toEqual([oldToken, refreshedToken]);
    });
  });

  test("deduplicates concurrent reauthentication after unauthenticated responses", async () => {
    await withFakeClock(async (_setNow, now) => {
      const paths = testPaths();
      const oldToken = token(now + 60 * 60_000);
      const refreshedToken = token(now + 2 * 60 * 60_000);
      writeConvexSession({ token: oldToken, refreshToken: "refresh-1" }, paths.sessionPath);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const transport = fakeTransport([
        async () => {
          started.resolve();
          await release.promise;
          return { token: refreshedToken, refreshToken: "refresh-2" };
        },
      ], [new Error("Unauthenticated"), new Error("Unauthenticated"), { id: "event-1", inserted: true }, { id: "event-2", inserted: true }]);
      const client = new ConvexContextClient({ ...paths, client: transport });

      const first = client.append(appendInput());
      const second = client.append({ ...appendInput(), id: "event-2" });
      await started.promise;
      expect(transport.actions).toHaveLength(1);
      release.resolve();
      await Promise.all([first, second]);

      expect(transport.actions).toHaveLength(1);
      expect(transport.mutations).toBe(4);
    });
  });

  test("does not retain a rejected authentication promise", async () => {
    await withFakeClock(async (_setNow, now) => {
      const paths = testPaths();
      writeFileSync(paths.setupKeyPath, "machine-key\n");
      const first = token(now + 60 * 60_000);
      const transport = fakeTransport([new Error("temporary auth failure"), { token: first, refreshToken: "refresh-1" }]);
      const client = new ConvexContextClient({ ...paths, client: transport });

      let rejected = false;
      try {
        await client.append(appendInput());
      } catch (error) {
        rejected = true;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Convex authentication is required");
      }
      expect(rejected).toBe(true);
      await client.append(appendInput());

      expect(transport.actions).toHaveLength(2);
      expect(transport.mutations).toBe(1);
    });
  });
});
