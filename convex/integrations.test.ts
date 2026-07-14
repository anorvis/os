import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

async function owner() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { email: "owner@example.test" }),
  );
  const client = t.withIdentity({ subject: userId });
  const workspaceId = await client.mutation(api.workspaces.ensureDefault, {});
  return { t, client, workspaceId };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
afterEach(() => {
  vi.restoreAllMocks();
});


describe("provider connections", () => {
  it("encrypts credentials and returns only redacted connection metadata", async () => {
    const { t, client } = await owner();
    await client.action(api.hevy.saveSettings, { apiKey: "hevy-secret-token" });

    const providers = await client.query(api.integrations.list, {});
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      provider: "hevy",
      status: "connected",
      hasCredentials: true,
    });
    expect(providers[0]).not.toHaveProperty("credentials");

    const raw = await t.run((ctx) => ctx.db.query("providerConnections").first());
    expect(raw?.credentials?.ciphertext).not.toContain("hevy-secret-token");
    expect(JSON.stringify(raw)).not.toContain("hevy-secret-token");

    await client.mutation(api.integrations.disconnect, { provider: "hevy" });
    const disconnected = await t.run((ctx) =>
      ctx.db.query("providerConnections").first(),
    );
    expect(disconnected).toMatchObject({ status: "available" });
    expect(disconnected?.credentials).toBeUndefined();
  });

  it("lists and updates Hevy routines through authenticated provider actions", async () => {
    const { client } = await owner();
    await client.action(api.hevy.saveSettings, { apiKey: "hevy-secret-token" });
    const routine = {
      id: "routine-1",
      title: "Upper",
      updated_at: "2026-07-14T00:00:00.000Z",
      exercises: [{
        title: "Bench Press",
        exercise_template_id: "template-1",
        rest_seconds: 90,
        notes: null,
        superset_id: null,
        sets: [{ type: "normal", reps: 8, weight_kg: 80 }],
      }],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      expect(new Headers(init?.headers).get("api-key")).toBe("hevy-secret-token");
      if (url.includes("exercise_templates")) {
        return Response.json({
          exercise_templates: [{ id: "template-1", title: "Bench Press" }],
          page_count: 1,
        });
      }
      if (init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          routine: {
            title: "Upper",
            exercises: [{ exercise_template_id: "template-1" }],
          },
        });
        return Response.json({ routine });
      }
      return Response.json({ routines: [routine], page_count: 1 });
    });

    const listed = await client.action(api.hevy.listRoutines, {});
    const templates = await client.action(api.hevy.listExerciseTemplates, {});
    const saved = await client.action(api.hevy.saveRoutine, {
      routine: listed.routines[0],
    });

    expect(listed.routines[0]).toMatchObject({
      id: "routine-1",
      exercises: [{ exerciseTemplateId: "template-1" }],
    });
    expect(templates.exerciseTemplates).toEqual([
      { id: "template-1", title: "Bench Press" },
    ]);
    expect(saved.id).toBe("routine-1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stores concurrent short-lived OAuth states and consumes each once", async () => {
    const { t, client } = await owner();
    const input = {
      clientId: "google-client",
      clientSecret: "google-secret",
      redirectUri: "http://127.0.0.1:3211/oauth/google/callback",
      returnTo: "http://127.0.0.1:3000/life",
    };
    const first = await client.action(api.google.start, input);
    const second = await client.action(api.google.start, input);
    const states = await t.run((ctx) => ctx.db.query("oauthStates").collect());
    expect(states).toHaveLength(2);

    for (const result of [first, second]) {
      const state = new URL(result.authorizationUrl).searchParams.get("state");
      expect(state).toBeTruthy();
      const args = { stateHash: await sha256(state!), now: Date.now() };
      await t.mutation(internal.integrations.consumeGoogleState, args);
      await expect(
        t.mutation(internal.integrations.consumeGoogleState, args),
      ).rejects.toThrow("OAuth state is invalid or expired");
    }
  });

  it("stores Pinterest OAuth state with encrypted client credentials", async () => {
    const { t, client } = await owner();
    const result = await client.action(api.pinterest.start, {
      clientId: "pinterest-client",
      clientSecret: "pinterest-secret",
      redirectUri: "http://127.0.0.1:3211/oauth/pinterest/callback",
      returnTo: "http://127.0.0.1:3000/life",
    });
    const authorizationUrl = new URL(result.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://www.pinterest.com");
    expect(authorizationUrl.searchParams.get("scope")).toBe("boards:read,pins:read");
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const connection = await t.run((ctx) =>
      ctx.db.query("providerConnections").first(),
    );
    expect(connection).toMatchObject({
      provider: "pinterest",
      status: "pending",
      scopes: ["boards:read", "pins:read"],
    });
    expect(JSON.stringify(connection)).not.toContain("pinterest-secret");

    const args = { stateHash: await sha256(state!), now: Date.now() };
    const consumed = await t.mutation(internal.integrations.consumePinterestState, args);
    expect(consumed.provider).toBe("pinterest");
    await expect(
      t.mutation(internal.integrations.consumePinterestState, args),
    ).rejects.toThrow("OAuth state is invalid or expired");
  });

  it("persists page cursors and fences stale resumptions", async () => {
    const { t, workspaceId } = await owner();
    const now = Date.now();
    const jobId = await t.run((ctx) =>
      ctx.db.insert("syncJobs", {
        workspaceId,
        provider: "google",
        kind: "manual",
        status: "pending",
        fetchedCount: 0,
        appliedCount: 0,
        skippedCount: 0,
        attempt: 0,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const first = await t.mutation(internal.maintenance.claimProviderSync, { jobId });
    expect(first).not.toBeNull();
    const cursor = JSON.stringify({ pageToken: "page-2" });
    await t.mutation(internal.maintenance.advanceProviderSync, {
      jobId,
      lease: first!.lease,
      done: false,
      cursor,
      fetched: 250,
      applied: 240,
      skipped: 10,
    });
    const checkpoint = await t.run((ctx) => ctx.db.get(jobId));
    expect(checkpoint).toMatchObject({
      status: "pending",
      cursor,
      fetchedCount: 250,
      appliedCount: 240,
      skippedCount: 10,
    });

    const second = await t.mutation(internal.maintenance.claimProviderSync, { jobId });
    expect(second!.cursor).toBe(cursor);
    expect(second!.lease).toBeGreaterThan(first!.lease);
    const stale = await t.mutation(internal.maintenance.advanceProviderSync, {
      jobId,
      lease: first!.lease,
      done: true,
      fetched: 999,
      applied: 999,
      skipped: 0,
    });
    expect(stale).toBe(false);
    await t.mutation(internal.maintenance.advanceProviderSync, {
      jobId,
      lease: second!.lease,
      done: true,
      fetched: 100,
      applied: 95,
      skipped: 5,
    });
    const completed = await t.run((ctx) => ctx.db.get(jobId));
    expect(completed).toMatchObject({
      status: "completed",
      fetchedCount: 350,
      appliedCount: 335,
      skippedCount: 15,
    });
  });
});
