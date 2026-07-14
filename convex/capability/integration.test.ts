import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";

async function owner() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { email: "owner@example.test" }),
  );
  const client = t.withIdentity({ subject: userId });
  const workspaceId = await client.mutation(api.platform.workspace.ensureDefault, {});
  return { t, client, workspaceId };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});


describe("provider connections", () => {
  it("encrypts credentials and returns only redacted connection metadata", async () => {
    const { t, client } = await owner();
    await client.action(api.capability.integration.hevy.saveSettings, { apiKey: "hevy-secret-token" });

    const providers = await client.query(api.capability.integration.list, {});
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

    await client.mutation(api.capability.integration.disconnect, { provider: "hevy" });
    const disconnected = await t.run((ctx) =>
      ctx.db.query("providerConnections").first(),
    );
    expect(disconnected).toMatchObject({ status: "available" });
    expect(disconnected?.credentials).toBeUndefined();
  });

  it("lists and updates Hevy routines through authenticated provider actions", async () => {
    const { client } = await owner();
    await client.action(api.capability.integration.hevy.saveSettings, { apiKey: "hevy-secret-token" });
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      expect(new Headers(init?.headers).get("api-key")).toBe("hevy-secret-token");
      if (url.includes("exercise_templates")) {
        return Promise.resolve(Response.json({
          exercise_templates: [{ id: "template-1", title: "Bench Press" }],
          page_count: 1,
        }));
      }
      if (init?.method === "PUT") {
        if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
        expect(JSON.parse(init.body)).toMatchObject({
          routine: {
            title: "Upper",
            exercises: [{ exercise_template_id: "template-1" }],
          },
        });
        return Promise.resolve(Response.json({ routine }));
      }
      return Promise.resolve(Response.json({ routines: [routine], page_count: 1 }));
    });

    const listed = await client.action(api.capability.integration.hevy.listRoutines, {});
    const templates = await client.action(api.capability.integration.hevy.listExerciseTemplates, {});
    const saved = await client.action(api.capability.integration.hevy.saveRoutine, {
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
    const first = await client.action(api.capability.integration.google.start, input);
    const second = await client.action(api.capability.integration.google.start, input);
    const states = await t.run((ctx) => ctx.db.query("oauthStates").collect());
    expect(states).toHaveLength(2);

    for (const result of [first, second]) {
      const state = new URL(result.authorizationUrl).searchParams.get("state");
      expect(state).toBeTruthy();
      const args = { stateHash: await sha256(state!), now: Date.now() };
      await t.mutation(internal.capability.integration.consumeGoogleState, args);
      await expect(
        t.mutation(internal.capability.integration.consumeGoogleState, args),
      ).rejects.toThrow("OAuth state is invalid or expired");
    }
  });

  it("stores Pinterest OAuth state with encrypted client credentials", async () => {
    const { t, client } = await owner();
    const result = await client.action(api.capability.integration.pinterest.start, {
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
    const consumed = await t.mutation(internal.capability.integration.consumePinterestState, args);
    expect(consumed.provider).toBe("pinterest");
    await expect(
      t.mutation(internal.capability.integration.consumePinterestState, args),
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
    const first = await t.mutation(internal.capability.integration.jobs.claimProviderSync, { jobId });
    expect(first).not.toBeNull();
    const cursor = JSON.stringify({ pageToken: "page-2" });
    await t.mutation(internal.capability.integration.jobs.advanceProviderSync, {
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

    const second = await t.mutation(internal.capability.integration.jobs.claimProviderSync, { jobId });
    expect(second!.cursor).toBe(cursor);
    expect(second!.lease).toBeGreaterThan(first!.lease);
    const stale = await t.mutation(internal.capability.integration.jobs.advanceProviderSync, {
      jobId,
      lease: first!.lease,
      done: true,
      fetched: 999,
      applied: 999,
      skipped: 0,
    });
    expect(stale).toBe(false);
    await t.mutation(internal.capability.integration.jobs.advanceProviderSync, {
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

describe("Google calendar lifecycle", () => {
  function googleResponses(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    return (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Promise.resolve(Response.json({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar.readonly",
        }));
      }
      if (url.includes("/users/me/calendarList")) {
        return Promise.resolve(Response.json({
          items: [
            { id: "owner@example.test", primary: true, selected: true },
            { id: "team@group.calendar.google.com", selected: true },
            { id: "ignored@group.calendar.google.com", selected: false },
          ],
        }));
      }
      if (url.includes("/calendars/primary/events")) {
        return Promise.resolve(Response.json({
          items: [{
            id: "event-1",
            summary: "Primary standup",
            start: { dateTime: "2026-07-15T10:00:00.000Z" },
            end: { dateTime: "2026-07-15T10:30:00.000Z" },
          }],
        }));
      }
      if (url.includes("/calendars/team%40group.calendar.google.com/events")) {
        return Promise.resolve(Response.json({
          items: [{
            id: "event-1",
            summary: "Team review",
            start: { dateTime: "2026-07-15T15:00:00.000Z" },
            end: { dateTime: "2026-07-15T16:00:00.000Z" },
          }],
        }));
      }
      return Promise.resolve(Response.json({ error: `unexpected ${url}` }, { status: 500 }));
    };
  }

  // Fake timers must be active while scheduling happens, or
  // finishAllScheduledFunctions cannot drain the runner chain.
  async function connectedGoogle() {
    const { t, client, workspaceId } = await owner();
    // Store credentials through the real encryption path.
    const start = await client.action(api.capability.integration.google.start, {
      clientId: "google-client",
      clientSecret: "google-secret",
      redirectUri: "http://127.0.0.1:3211/oauth/google/callback",
      returnTo: "http://127.0.0.1:3000/life",
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(googleResponses());
    vi.useFakeTimers();
    const returnTo = await t.action(internal.capability.integration.google.completeOAuth, {
      code: "auth-code",
      state: state!,
    });
    const drain = () => t.finishAllScheduledFunctions(vi.runAllTimers);
    return { t, client, workspaceId, fetchMock, returnTo, drain };
  }

  it("queues an initial sync on OAuth completion and hands the job to the landing page", async () => {
    const { t, client, returnTo, drain } = await connectedGoogle();
    const landing = new URL(returnTo);
    expect(`${landing.origin}${landing.pathname}`).toBe("http://127.0.0.1:3000/life");
    // Branded ID from a URL parameter; the query rejects foreign workspaces.
    const handedJobId = landing.searchParams.get("googleSync") as Id<"syncJobs"> | null;
    expect(handedJobId).toBeTruthy();

    // The landing page can follow exactly the job it was handed.
    const queued = await client.query(api.capability.integration.syncJobStatus, {
      jobId: handedJobId!,
    });
    expect(queued).toMatchObject({ provider: "google", status: "pending" });

    await drain();

    const finished = await client.query(api.capability.integration.syncJobStatus, {
      jobId: handedJobId!,
    });
    expect(finished).toMatchObject({ status: "completed" });

    const jobs = await t.run((ctx) => ctx.db.query("syncJobs").collect());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ provider: "google", status: "completed" });

    const events = await t.run((ctx) => ctx.db.query("calendarEvents").collect());
    expect(events).toHaveLength(2);
    const byCalendar = new Map(events.map((event) => [event.calendarId, event]));
    expect(byCalendar.get("primary")).toMatchObject({
      providerEventId: "event-1",
      summary: "Primary standup",
    });
    expect(byCalendar.get("team@group.calendar.google.com")).toMatchObject({
      providerEventId: "event-1",
      summary: "Team review",
    });

    // Same raw event id on two calendars must never collide.
    const second = await client.mutation(api.capability.integration.startSync, {
      provider: "google",
    });
    await drain();
    expect(second).toBeTruthy();
    const after = await t.run((ctx) => ctx.db.query("calendarEvents").collect());
    expect(after).toHaveLength(2);
  });

  it("reschedules the runner for a job stuck pending after a dead runner", async () => {
    const { t, client, workspaceId, drain } = await connectedGoogle();
    await drain();

    // Simulate a runner that died before claiming: pending, never started.
    const stuckId = await t.run((ctx) =>
      ctx.db.insert("syncJobs", {
        workspaceId,
        provider: "google",
        kind: "manual",
        status: "pending",
        fetchedCount: 0,
        appliedCount: 0,
        skippedCount: 0,
        attempt: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const jobId = await client.mutation(api.capability.integration.startSync, {
      provider: "google",
    });
    expect(jobId).toBe(stuckId);
    await drain();

    const job = await t.run((ctx) => ctx.db.get(stuckId));
    expect(job).toMatchObject({ status: "completed" });
  });

  it("keeps the OAuth client config on disconnect and signs back in without it", async () => {
    const { t, client, workspaceId } = await connectedGoogle();

    const result = await client.action(api.capability.integration.google.disconnect, {});
    expect(result).toEqual({ ok: true, hasClientConfig: true });

    const connection = await t.run((ctx) =>
      ctx.db
        .query("providerConnections")
        .withIndex("by_workspace_provider", (q) =>
          q.eq("workspaceId", workspaceId).eq("provider", "google"),
        )
        .unique(),
    );
    expect(connection).toMatchObject({ status: "available" });
    expect(connection?.credentials).toBeDefined();
    expect(
      connection?.provider === "google" ? connection.accessTokenExpiresAt : "wrong provider",
    ).toBeUndefined();

    // Any queued or running sync work stops with the disconnect.
    const jobs = await t.run((ctx) => ctx.db.query("syncJobs").collect());
    for (const job of jobs) {
      expect(job.status === "completed" || job.status === "failed").toBe(true);
    }

    // Re-sign-in requires no client keys: start uses the preserved config.
    const restart = await client.action(api.capability.integration.google.start, {
      redirectUri: "http://127.0.0.1:3211/oauth/google/callback",
      returnTo: "http://127.0.0.1:3000/life",
    });
    const url = new URL(restart.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe("google-client");
  });
});
