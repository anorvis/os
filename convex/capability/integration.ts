import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { requireWorkspace } from "../platform/auth/access";
import {
  cancelActiveSyncs,
  enqueueSync,
  recordProviderSyncFailure,
  type SyncProvider,
} from "./integration/jobs";
import { parseProviderDecimal } from "./finance/decimal";

const provider = v.union(
  v.literal("google"),
  v.literal("pinterest"),
  v.literal("hevy"),
  v.literal("snaptrade"),
);
const syncProvider = v.union(
  v.literal("google"),
  v.literal("hevy"),
  v.literal("snaptrade"),
);
const encryptedCredentials = v.object({
  algorithm: v.literal("aes-256-gcm"),
  keyVersion: v.number(),
  nonce: v.string(),
  ciphertext: v.string(),
});
const schedule = v.union(
  v.object({
    kind: v.literal("timed"),
    startAt: v.number(),
    endAt: v.number(),
    timezone: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("all_day"),
    startDate: v.string(),
    endDateExclusive: v.string(),
  }),
);
const hevySet = v.object({
  setType: v.string(),
  reps: v.optional(v.number()),
  weightKg: v.optional(v.number()),
  durationSeconds: v.optional(v.number()),
  distanceMeters: v.optional(v.number()),
});
const hevyExercise = v.object({
  title: v.string(),
  muscleGroups: v.array(v.string()),
  sets: v.array(hevySet),
});
const hevyWorkout = v.object({
  sourceId: v.string(),
  title: v.string(),
  startedAt: v.number(),
  durationSeconds: v.number(),
  notes: v.optional(v.string()),
  exercises: v.array(hevyExercise),
});

export const list = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const connections = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", access.workspaceId),
      )
      .collect();
    return Promise.all(
      connections.map(async ({ credentials, ...connection }) => {
        const syncState =
          connection.provider === "pinterest"
            ? null
            : await ctx.db
                .query("providerSyncStates")
                .withIndex("by_workspace_provider", (q) =>
                  q
                    .eq("workspaceId", access.workspaceId)
                    .eq("provider", connection.provider),
                )
                .unique();
        return {
          ...connection,
          hasCredentials: credentials !== undefined,
          sync: {
            sequence: syncState?.sequence ?? 0,
            lastSyncedAt: syncState?.lastSyncedAt ?? null,
            lastChangedAt: syncState?.lastChangedAt ?? null,
            lastAttemptAt: syncState?.lastAttemptAt ?? null,
            lastError: syncState?.lastError ?? null,
            lastErrorAt: syncState?.lastErrorAt ?? null,
          },
        };
      }),
    );
  },
});

const SYNC_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const SYNC_RETRY_HOLDOFF_MS = 10 * 60 * 1000;

// Catch-up for a backend that is not always running: clients call this once
// at session start and any provider whose last successful sync is stale gets
// a scheduled sync, without waiting for the next 6-hour cron tick.
export const syncStale = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const now = Date.now();
    const connections = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", access.workspaceId),
      )
      .collect();
    const enqueued: SyncProvider[] = [];
    for (const connection of connections) {
      if (
        (connection.provider !== "google" &&
          connection.provider !== "hevy" &&
          connection.provider !== "snaptrade") ||
        connection.status !== "connected" ||
        connection.credentials === undefined
      ) {
        continue;
      }
      const state = await ctx.db
        .query("providerSyncStates")
        .withIndex("by_workspace_provider", (q) =>
          q
            .eq("workspaceId", access.workspaceId)
            .eq("provider", connection.provider),
        )
        .unique();
      const fresh =
        state?.lastSyncedAt !== undefined &&
        now - state.lastSyncedAt < SYNC_STALE_AFTER_MS;
      const recentlyAttempted =
        state?.lastAttemptAt !== undefined &&
        now - state.lastAttemptAt < SYNC_RETRY_HOLDOFF_MS;
      if (fresh || recentlyAttempted) continue;
      const result = await enqueueSync(
        ctx,
        access.workspaceId,
        connection.provider,
        "scheduled",
      );
      if (result.scheduled) enqueued.push(connection.provider);
    }
    return enqueued;
  },
});

export const providerSyncState = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    provider: syncProvider,
  },
  handler: (ctx, args) =>
    ctx.db
      .query("providerSyncStates")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("provider", args.provider),
      )
      .unique(),
});

export const startSync = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    provider,
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    if (args.provider === "pinterest") {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Pinterest has no background sync",
      });
    }
    const connection = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", access.workspaceId).eq("provider", args.provider),
      )
      .unique();
    if (
      connection === null ||
      connection.status !== "connected" ||
      connection.credentials === undefined
    ) {
      throw new ConvexError({ code: "NOT_CONNECTED", message: "Provider is not connected" });
    }
    return (await enqueueSync(ctx, access.workspaceId, args.provider, "manual")).jobId;
  },
});

// Lets a landing page follow the one sync job it was handed (for example the
// initial sync queued by the Google OAuth callback).
export const syncJobStatus = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    jobId: v.id("syncJobs"),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.workspaceId !== access.workspaceId) return null;
    return {
      provider: job.provider,
      status: job.status,
      fetchedCount: job.fetchedCount,
      appliedCount: job.appliedCount,
      error: job.error,
      updatedAt: job.updatedAt,
    };
  },
});

export const disconnect = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    provider,
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const connection = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q
          .eq("workspaceId", access.workspaceId)
          .eq("provider", args.provider),
      )
      .unique();
    if (connection !== null) {
      await ctx.db.patch(connection._id, {
        status: "available",
        credentials: undefined,
        connectedAt: undefined,
        updatedAt: Date.now(),
      });
      if (args.provider !== "pinterest") {
        await cancelActiveSyncs(
          ctx,
          access.workspaceId,
          args.provider,
          "Provider was disconnected",
        );
      }
    }
    return args.provider;
  },
});

// Google keeps its OAuth client configuration on disconnect so signing back
// in never requires re-entering the client ID and secret.
export const resetGoogleConnection = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    credentials: v.optional(encryptedCredentials),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("provider", "google"),
      )
      .unique();
    if (connection === null) return null;
    await ctx.db.patch(connection._id, {
      status: "available",
      credentials: args.credentials,
      connectedAt: undefined,
      accessTokenExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    await cancelActiveSyncs(
      ctx,
      args.workspaceId,
      "google",
      "Google was disconnected",
    );
    return connection._id;
  },
});

// A revoked/expired Google refresh token cannot recover on its own; flag the
// connection so the dashboard shows a reconnect prompt and the scheduled
// cron stops hammering the token endpoint.
export const markGoogleReauthRequired = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("provider", "google"),
      )
      .unique();
    if (connection === null || connection.status !== "connected") return;
    await ctx.db.patch(connection._id, {
      status: "error",
      updatedAt: Date.now(),
    });
    await recordProviderSyncFailure(
      ctx,
      args.workspaceId,
      "google",
      "Google access expired or was revoked — reconnect Google Calendar.",
    );
  },
});

export const connection = internalQuery({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    provider,
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    return ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q
          .eq("workspaceId", access.workspaceId)
          .eq("provider", args.provider),
      )
      .unique();
  },
});

export const authorizeWorkspace = internalQuery({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) =>
    (await requireWorkspace(ctx, args.workspaceId)).workspaceId,
});

export const scheduledConnections = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("providerConnections").collect()).filter(
      (connection) =>
        connection.status === "connected" &&
        connection.credentials !== undefined,
    ),
});

export const connectionByWorkspace = internalQuery({
  args: { workspaceId: v.id("workspaces"), provider },
  handler: (ctx, args) =>
    ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("provider", args.provider),
      )
      .unique(),
});

export const snapTradeAccounts = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("financeAccounts")
      .withIndex("by_workspace_source_id", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("source", "snaptrade"),
      )
      .collect();
    return accounts.flatMap((account) =>
      account.sourceId
        ? [{ sourceId: account.sourceId, accountId: account._id, currency: account.currency }]
        : [],
    );
  },
});

export const saveHevyCredentials = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    credentials: encryptedCredentials,
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const existing = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", access.workspaceId).eq("provider", "hevy"),
      )
      .unique();
    const now = Date.now();
    if (existing !== null) {
      await ctx.db.replace(existing._id, {
        workspaceId: access.workspaceId,
        provider: "hevy",
        status: "connected",
        credentials: args.credentials,
        connectedAt: existing.connectedAt ?? now,
        updatedAt: now,
      });
      return existing._id;
    }
    return ctx.db.insert("providerConnections", {
      workspaceId: access.workspaceId,
      provider: "hevy",
      status: "connected",
      credentials: args.credentials,
      connectedAt: now,
      updatedAt: now,
    });
  },
});

export const saveSnapTradeCredentials = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    credentials: encryptedCredentials,
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const existing = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", access.workspaceId).eq("provider", "snaptrade"),
      )
      .unique();
    const now = Date.now();
    if (existing !== null) {
      await ctx.db.replace(existing._id, {
        workspaceId: access.workspaceId,
        provider: "snaptrade",
        status: "connected",
        lastCheckedAt: now,
        credentials: args.credentials,
        connectedAt: existing.connectedAt ?? now,
        updatedAt: now,
      });
      return existing._id;
    }
    return ctx.db.insert("providerConnections", {
      workspaceId: access.workspaceId,
      provider: "snaptrade",
      status: "connected",
      lastCheckedAt: now,
      credentials: args.credentials,
      connectedAt: now,
      updatedAt: now,
    });
  },
});

export const beginGoogle = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    credentials: encryptedCredentials,
    scopes: v.array(v.string()),
    stateHash: v.string(),
    redirectUri: v.string(),
    returnTo: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const existing = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", access.workspaceId).eq("provider", "google"),
      )
      .unique();
    const now = Date.now();
    if (existing !== null) {
      await ctx.db.replace(existing._id, {
        workspaceId: access.workspaceId,
        provider: "google",
        status: "pending",
        scopes: args.scopes,
        credentials: args.credentials,
        connectedAt: existing.connectedAt,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("providerConnections", {
        workspaceId: access.workspaceId,
        provider: "google",
        status: "pending",
        scopes: args.scopes,
        credentials: args.credentials,
        updatedAt: now,
      });
    }
    await ctx.db.insert("oauthStates", {
      workspaceId: access.workspaceId,
      provider: "google",
      stateHash: args.stateHash,
      redirectUri: args.redirectUri,
      returnTo: args.returnTo,
      expiresAt: args.expiresAt,
      createdAt: now,
    });
    return access.workspaceId;
  },
});

export const beginPinterest = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    credentials: encryptedCredentials,
    scopes: v.array(v.string()),
    stateHash: v.string(),
    redirectUri: v.string(),
    returnTo: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const existing = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", access.workspaceId).eq("provider", "pinterest"),
      )
      .unique();
    const now = Date.now();
    if (existing !== null) {
      await ctx.db.replace(existing._id, {
        workspaceId: access.workspaceId,
        provider: "pinterest",
        status: "pending",
        scopes: args.scopes,
        credentials: args.credentials,
        connectedAt: existing.connectedAt,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("providerConnections", {
        workspaceId: access.workspaceId,
        provider: "pinterest",
        status: "pending",
        scopes: args.scopes,
        credentials: args.credentials,
        updatedAt: now,
      });
    }
    await ctx.db.insert("oauthStates", {
      workspaceId: access.workspaceId,
      provider: "pinterest",
      stateHash: args.stateHash,
      redirectUri: args.redirectUri,
      returnTo: args.returnTo,
      expiresAt: args.expiresAt,
      createdAt: now,
    });
    return access.workspaceId;
  },
});


export const consumeProviderState = internalMutation({
  args: { stateHash: v.string(), provider, now: v.number() },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("oauthStates")
      .withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (
      state === null ||
      state.provider !== args.provider ||
      state.consumedAt !== undefined ||
      state.expiresAt < args.now
    ) {
      throw new ConvexError({ code: "FORBIDDEN", message: "OAuth state is invalid or expired" });
    }
    await ctx.db.patch(state._id, { consumedAt: args.now });
    return state;
  },
});

export const consumeGoogleState = internalMutation({
  args: { stateHash: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("oauthStates")
      .withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (
      state === null ||
      state.provider !== "google" ||
      state.consumedAt !== undefined ||
      state.expiresAt < args.now
    ) {
      throw new ConvexError({ code: "FORBIDDEN", message: "OAuth state is invalid or expired" });
    }
    await ctx.db.patch(state._id, { consumedAt: args.now });
    return state;
  },
});

export const consumePinterestState = internalMutation({
  args: { stateHash: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("oauthStates")
      .withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (
      state === null ||
      state.provider !== "pinterest" ||
      state.consumedAt !== undefined ||
      state.expiresAt < args.now
    ) {
      throw new ConvexError({ code: "FORBIDDEN", message: "OAuth state is invalid or expired" });
    }
    await ctx.db.patch(state._id, { consumedAt: args.now });
    return state;
  },
});

export const finishGoogle = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    credentials: encryptedCredentials,
    scopes: v.array(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("provider", "google"),
      )
      .unique();
    if (connection === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Google connection not found" });
    }
    const now = Date.now();
    await ctx.db.replace(connection._id, {
      workspaceId: args.workspaceId,
      provider: "google",
      status: "connected",
      scopes: args.scopes,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      credentials: args.credentials,
      connectedAt: connection.connectedAt ?? now,
      updatedAt: now,
    });
  },
});

export const finishPinterest = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    credentials: encryptedCredentials,
    scopes: v.array(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("providerConnections")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("provider", "pinterest"),
      )
      .unique();
    if (connection === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Pinterest connection not found" });
    }
    const now = Date.now();
    await ctx.db.replace(connection._id, {
      workspaceId: args.workspaceId,
      provider: "pinterest",
      status: "connected",
      scopes: args.scopes,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      credentials: args.credentials,
      connectedAt: connection.connectedAt ?? now,
      updatedAt: now,
    });
  },
});

// The user-visible tags synced records carry. Each lifeTags row is keyed by
// systemKey so renames are impossible and the tag survives hides only through
// explicit backend seeding, never by name-matching a user tag.
const GOOGLE_TAG = {
  systemKey: "google-calendar",
  name: "Google Calendar",
  color: "#4285f4",
} as const;
const HEVY_TAG = {
  systemKey: "hevy",
  name: "Hevy",
  color: "#ef4444",
} as const;

type SystemTag = typeof GOOGLE_TAG | typeof HEVY_TAG;

async function ensureSystemTag(
  ctx: { db: MutationCtx["db"] },
  workspaceId: Id<"workspaces">,
  spec: SystemTag,
): Promise<string> {
  const existing = await ctx.db
    .query("lifeTags")
    .withIndex("by_workspace_system", (q) =>
      q.eq("workspaceId", workspaceId).eq("systemKey", spec.systemKey),
    )
    .unique();
  if (existing !== null) {
    // A hide that predates the deletion guard must not bury the tag forever:
    // events sync tagged with it, so revive it (keeping any user color).
    if (existing.hidden) {
      await ctx.db.patch(existing._id, { hidden: false, updatedAt: Date.now() });
    }
    return existing.name;
  }
  const now = Date.now();
  // Only auto-created tags may be undeletable: never adopt a user tag that
  // already owns the canonical name. Pick the first free integration-owned
  // name instead (two rows with one normalizedName would break every
  // unique() lookup on by_workspace_name).
  let name: string = spec.name;
  for (let suffix = 0; ; suffix += 1) {
    if (suffix > 0) name = `${spec.name} (integration${suffix > 1 ? ` ${suffix}` : ""})`;
    const taken = await ctx.db
      .query("lifeTags")
      .withIndex("by_workspace_name", (q) =>
        q.eq("workspaceId", workspaceId).eq("normalizedName", name.toLocaleLowerCase()),
      )
      .unique();
    if (taken === null) break;
  }
  await ctx.db.insert("lifeTags", {
    workspaceId,
    name,
    normalizedName: name.toLocaleLowerCase(),
    color: spec.color,
    hidden: false,
    systemKey: spec.systemKey,
    createdAt: now,
    updatedAt: now,
  });
  return name;
}

export const upsertGoogleEvents = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    system: v.optional(v.boolean()),
    events: v.array(
      v.object({
        providerEventId: v.string(),
        calendarId: v.string(),
        summary: v.string(),
        schedule,
        startDay: v.string(),
        endDay: v.string(),
        location: v.optional(v.string()),
        description: v.optional(v.string()),
        sourceHash: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const access = args.system
      ? { workspaceId: args.workspaceId! }
      : await requireWorkspace(ctx, args.workspaceId);
    const tag = await ensureSystemTag(ctx, access.workspaceId, GOOGLE_TAG);
    let created = 0;
    let updated = 0;
    for (const event of args.events) {
      const existing = await ctx.db
        .query("calendarEvents")
        .withIndex("by_workspace_provider_calendar_event", (q) =>
          q
            .eq("workspaceId", access.workspaceId)
            .eq("provider", "google")
            .eq("calendarId", event.calendarId)
            .eq("providerEventId", event.providerEventId),
        )
        .unique();
      const now = Date.now();
      const value = {
        summary: event.summary,
        schedule: event.schedule,
        startDay: event.startDay,
        endDay: event.endDay,
        location: event.location,
        description: event.description,
        source: "google" as const,
        readOnly: true,
        provider: "google",
        providerEventId: event.providerEventId,
        calendarId: event.calendarId,
        tag,
        sourceHash: event.sourceHash,
        updatedAt: now,
      };
      if (existing === null) {
        await ctx.db.insert("calendarEvents", {
          workspaceId: access.workspaceId,
          ...value,
          createdAt: now,
        });
        created += 1;
      } else {
        await ctx.db.patch(existing._id, value);
        updated += 1;
      }
    }
    return { created, updated };
  },
});

// Idempotent repair: Google rows outside the rolling sync window are never
// re-upserted, so enforce the canonical tag here (fills gaps and fixes stale
// or case-variant values that exact-name matching would orphan).
export const backfillGoogleEventTags = internalMutation({
  args: {},
  handler: async (ctx) => {
    let tagged = 0;
    const workspaces = await ctx.db.query("workspaces").collect();
    for (const workspace of workspaces) {
      const events = await ctx.db
        .query("calendarEvents")
        .withIndex("by_workspace_provider_calendar_event", (q) =>
          q.eq("workspaceId", workspace._id).eq("provider", "google"),

        )
        .collect();
      if (events.length === 0) continue;
      const tag = await ensureSystemTag(ctx, workspace._id, GOOGLE_TAG);
      for (const event of events) {
        if (event.tag === tag) continue;
        await ctx.db.patch(event._id, { tag, updatedAt: Date.now() });
        tagged += 1;
      }
    }
    return { tagged };
  },
});

type HevyWorkoutInput = {
  sourceId: string;
  title: string;
  startedAt: number;
  durationSeconds: number;
  notes?: string;
  exercises: Array<{
    title: string;
    muscleGroups: string[];
    sets: Array<{
      setType: string;
      reps?: number;
      weightKg?: number;
      durationSeconds?: number;
      distanceMeters?: number;
    }>;
  }>;
};

async function applyHevyWorkoutRows(
  ctx: { db: MutationCtx["db"] },
  workspaceId: Id<"workspaces">,
  workouts: HevyWorkoutInput[],
  deletedSourceIds: string[],
): Promise<{ created: number; updated: number; deleted: number; skipped: number }> {
  if (workouts.length > 0) await ensureSystemTag(ctx, workspaceId, HEVY_TAG);
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;
  for (const input of workouts) {
    const existing = await ctx.db
      .query("workouts")
      .withIndex("by_workspace_source_id", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("source", "hevy")
          .eq("sourceId", input.sourceId),
      )
      .unique();
    const now = Date.now();
    if (existing === null) {
      const workoutId = await ctx.db.insert("workouts", {
        workspaceId,
        source: "hevy",
        sourceId: input.sourceId,
        title: input.title,
        startedAt: input.startedAt,
        durationSeconds: input.durationSeconds,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      });
      for (const [order, exercise] of input.exercises.entries()) {
        const exerciseId = await ctx.db.insert("workoutExercises", {
          workspaceId,
          workoutId,
          title: exercise.title,
          muscleGroups: exercise.muscleGroups,
          order,
        });
        for (const [setOrder, set] of exercise.sets.entries()) {
          await ctx.db.insert("exerciseSets", {
            workspaceId,
            workoutId,
            workoutExerciseId: exerciseId,
            ...set,
            order: setOrder,
          });
        }
      }
      created += 1;
      continue;
    }

    const [exercises, sets] = await Promise.all([
      ctx.db
        .query("workoutExercises")
        .withIndex("by_workout_order", (q) => q.eq("workoutId", existing._id))
        .collect(),
      ctx.db
        .query("exerciseSets")
        .withIndex("by_workout", (q) => q.eq("workoutId", existing._id))
        .collect(),
    ]);
    const childrenMatch =
      exercises.length === input.exercises.length &&
      input.exercises.every((exercise, order) => {
        const current = exercises.find((row) => row.order === order);
        if (
          current === undefined ||
          current.title !== exercise.title ||
          JSON.stringify(current.muscleGroups) !== JSON.stringify(exercise.muscleGroups)
        ) {
          return false;
        }
        const currentSets = sets
          .filter((set) => set.workoutExerciseId === current._id)
          .sort((a, b) => a.order - b.order);
        return (
          currentSets.length === exercise.sets.length &&
          exercise.sets.every((set, setOrder) => {
            const currentSet = currentSets[setOrder];
            return (
              currentSet !== undefined &&
              currentSet.setType === set.setType &&
              currentSet.reps === set.reps &&
              currentSet.weightKg === set.weightKg &&
              currentSet.durationSeconds === set.durationSeconds &&
              currentSet.distanceMeters === set.distanceMeters
            );
          })
        );
      });
    const parentChanged =
      existing.title !== input.title ||
      existing.startedAt !== input.startedAt ||
      existing.durationSeconds !== input.durationSeconds ||
      existing.notes !== input.notes;
    if (!parentChanged && childrenMatch) {
      skipped += 1;
      continue;
    }
    if (parentChanged) {
      await ctx.db.patch(existing._id, {
        title: input.title,
        startedAt: input.startedAt,
        durationSeconds: input.durationSeconds,
        notes: input.notes,
        updatedAt: now,
      });
    }
    if (!childrenMatch) {
      for (const set of sets) await ctx.db.delete(set._id);
      for (const exercise of exercises) await ctx.db.delete(exercise._id);
      for (const [order, exercise] of input.exercises.entries()) {
        const exerciseId = await ctx.db.insert("workoutExercises", {
          workspaceId,
          workoutId: existing._id,
          title: exercise.title,
          muscleGroups: exercise.muscleGroups,
          order,
        });
        for (const [setOrder, set] of exercise.sets.entries()) {
          await ctx.db.insert("exerciseSets", {
            workspaceId,
            workoutId: existing._id,
            workoutExerciseId: exerciseId,
            ...set,
            order: setOrder,
          });
        }
      }
    }
    updated += 1;
  }
  for (const sourceId of new Set(deletedSourceIds)) {
    const existing = await ctx.db
      .query("workouts")
      .withIndex("by_workspace_source_id", (q) =>
        q.eq("workspaceId", workspaceId).eq("source", "hevy").eq("sourceId", sourceId),
      )
      .unique();
    if (existing === null) {
      skipped += 1;
      continue;
    }
    const [exercises, sets] = await Promise.all([
      ctx.db
        .query("workoutExercises")
        .withIndex("by_workout_order", (q) => q.eq("workoutId", existing._id))
        .collect(),
      ctx.db
        .query("exerciseSets")
        .withIndex("by_workout", (q) => q.eq("workoutId", existing._id))
        .collect(),
    ]);
    for (const set of sets) await ctx.db.delete(set._id);
    for (const exercise of exercises) await ctx.db.delete(exercise._id);
    await ctx.db.delete(existing._id);
    deleted += 1;
  }
  return { created, updated, deleted, skipped };
}

export const upsertHevyWorkouts = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    system: v.optional(v.boolean()),
    workouts: v.array(hevyWorkout),
  },
  handler: async (ctx, args) => {
    const access = args.system
      ? { workspaceId: args.workspaceId! }
      : await requireWorkspace(ctx, args.workspaceId);
    return applyHevyWorkoutRows(ctx, access.workspaceId, args.workouts, []);
  },
});

export const applyHevyLiveWorkouts = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    system: v.optional(v.boolean()),
    workouts: v.array(hevyWorkout),
    deletedSourceIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const access = args.system
      ? { workspaceId: args.workspaceId! }
      : await requireWorkspace(ctx, args.workspaceId);
    return applyHevyWorkoutRows(
      ctx,
      access.workspaceId,
      args.workouts,
      args.deletedSourceIds,
    );
  },
});

export const upsertHevyMeasurements = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    system: v.optional(v.boolean()),
    measurements: v.array(
      v.object({
        sourceId: v.string(),
        recordedAt: v.number(),
        weightKg: v.optional(v.number()),
        leanMassKg: v.optional(v.number()),
        fatPercent: v.optional(v.number()),
        neckCm: v.optional(v.number()),
        shoulderCm: v.optional(v.number()),
        chestCm: v.optional(v.number()),
        leftBicepCm: v.optional(v.number()),
        rightBicepCm: v.optional(v.number()),
        leftForearmCm: v.optional(v.number()),
        rightForearmCm: v.optional(v.number()),
        abdomenCm: v.optional(v.number()),
        waistCm: v.optional(v.number()),
        hipsCm: v.optional(v.number()),
        leftThighCm: v.optional(v.number()),
        rightThighCm: v.optional(v.number()),
        leftCalfCm: v.optional(v.number()),
        rightCalfCm: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const access = args.system
      ? { workspaceId: args.workspaceId! }
      : await requireWorkspace(ctx, args.workspaceId);
    let created = 0;
    let updated = 0;
    for (const input of args.measurements) {
      const existing = await ctx.db
        .query("bodyMeasurements")
        .withIndex("by_workspace_source_id", (q) =>
          q
            .eq("workspaceId", access.workspaceId)
            .eq("source", "hevy")
            .eq("sourceId", input.sourceId),
        )
        .unique();
      const now = Date.now();
      const value = {
        recordedAt: input.recordedAt,
        weightKg: input.weightKg,
        leanMassKg: input.leanMassKg,
        fatPercent: input.fatPercent,
        neckCm: input.neckCm,
        shoulderCm: input.shoulderCm,
        chestCm: input.chestCm,
        leftBicepCm: input.leftBicepCm,
        rightBicepCm: input.rightBicepCm,
        leftForearmCm: input.leftForearmCm,
        rightForearmCm: input.rightForearmCm,
        abdomenCm: input.abdomenCm,
        waistCm: input.waistCm,
        hipsCm: input.hipsCm,
        leftThighCm: input.leftThighCm,
        rightThighCm: input.rightThighCm,
        leftCalfCm: input.leftCalfCm,
        rightCalfCm: input.rightCalfCm,
        updatedAt: now,
      };
      if (existing === null) {
        await ctx.db.insert("bodyMeasurements", {
          workspaceId: access.workspaceId,
          source: "hevy",
          sourceId: input.sourceId,
          ...value,
          createdAt: now,
        });
        created += 1;
      } else {
        await ctx.db.patch(existing._id, value);
        updated += 1;
      }
    }
    return { created, updated };
  },
});

export const upsertSnapTradeAccounts = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    system: v.optional(v.boolean()),
    accounts: v.array(
      v.object({
        sourceId: v.string(),
        name: v.string(),
        institution: v.optional(v.string()),
        type: v.string(),
        currency: v.string(),
        balance: v.optional(v.string()),
        observedAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const access = args.system
      ? { workspaceId: args.workspaceId! }
      : await requireWorkspace(ctx, args.workspaceId);
    const ids: Array<{ sourceId: string; accountId: Id<"financeAccounts"> }> = [];
    for (const input of args.accounts) {
      const existing = await ctx.db
        .query("financeAccounts")
        .withIndex("by_workspace_source_id", (q) =>
          q
            .eq("workspaceId", access.workspaceId)
            .eq("source", "snaptrade")
            .eq("sourceId", input.sourceId),
        )
        .unique();
      const now = Date.now();
      const value = {
        name: input.name,
        institution: input.institution,
        type: input.type,
        currency: input.currency,
        balance:
          input.balance === undefined
            ? undefined
            : parseProviderDecimal(input.balance, "SnapTrade balance"),
        status: "active" as const,
        observedAt: input.observedAt,
        updatedAt: now,
      };
      const accountId =
        existing?._id ??
        (await ctx.db.insert("financeAccounts", {
          workspaceId: access.workspaceId,
          source: "snaptrade",
          sourceId: input.sourceId,
          ...value,
          createdAt: now,
        }));
      if (existing !== null) await ctx.db.patch(existing._id, value);
      ids.push({ sourceId: input.sourceId, accountId });
    }
    return ids;
  },
});

export const applySnapTradeAccountData = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    system: v.optional(v.boolean()),
    accountId: v.id("financeAccounts"),
    balances: v.array(
      v.object({
        currency: v.string(),
        cash: v.optional(v.string()),
        buyingPower: v.optional(v.string()),
        observedAt: v.number(),
      }),
    ),
    positions: v.array(
      v.object({
        sourceId: v.optional(v.string()),
        symbol: v.string(),
        name: v.optional(v.string()),
        quantity: v.string(),
        marketValue: v.optional(v.string()),
        averageCost: v.optional(v.string()),
        currency: v.string(),
        observedAt: v.optional(v.number()),
      }),
    ),
    activities: v.array(
      v.object({
        sourceId: v.optional(v.string()),
        fingerprint: v.string(),
        type: v.string(),
        description: v.optional(v.string()),
        amount: v.optional(v.string()),
        currency: v.string(),
        symbol: v.optional(v.string()),
        quantity: v.optional(v.string()),
        price: v.optional(v.string()),
        status: v.string(),
        occurredAt: v.number(),
        settledAt: v.optional(v.number()),
      }),
    ),
    history: v.array(
      v.object({
        date: v.string(),
        equity: v.string(),
        cash: v.optional(v.string()),
        currency: v.string(),
        observedAt: v.number(),
      }),
    ),
    returnRates: v.array(
      v.object({
        timeframe: v.string(),
        returnPercent: v.number(),
        asOf: v.optional(v.string()),
        observedAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const access = args.system
      ? { workspaceId: args.workspaceId! }
      : await requireWorkspace(ctx, args.workspaceId);
    const account = await ctx.db.get(args.accountId);
    if (account === null || account.workspaceId !== access.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Finance account not found" });
    }
    const now = Date.now();
    const ensureCategory = async (name: string, group: string) => {
      const normalizedName = name.toLocaleLowerCase();
      const existing = await ctx.db
        .query("financeCategories")
        .withIndex("by_workspace_name", (q) =>
          q.eq("workspaceId", access.workspaceId).eq("normalizedName", normalizedName),
        )
        .unique();
      if (existing !== null) {
        if (existing.group !== group) {
          await ctx.db.patch(existing._id, { group });
        }
        return existing._id;
      }
      return ctx.db.insert("financeCategories", {
        workspaceId: access.workspaceId,
        name,
        normalizedName,
        group,
        excludeFromSpending: false,
      });
    };
    const [transfersCategoryId, investingCategoryId] = await Promise.all([
      ensureCategory("Transfers", "transfers"),
      ensureCategory("Investing", "investing"),
    ]);
    for (const input of args.balances) {
      const existing = await ctx.db
        .query("financeBalances")
        .withIndex("by_account_currency", (q) =>
          q.eq("accountId", account._id).eq("currency", input.currency),
        )
        .unique();
      const value = {
        cash:
          input.cash === undefined
            ? undefined
            : parseProviderDecimal(input.cash, "SnapTrade cash balance"),
        buyingPower:
          input.buyingPower === undefined
            ? undefined
            : parseProviderDecimal(input.buyingPower, "SnapTrade buying power"),
        observedAt: input.observedAt,
        source: "snaptrade" as const,
        updatedAt: now,
      };
      if (existing === null) {
        await ctx.db.insert("financeBalances", {
          workspaceId: access.workspaceId,
          accountId: account._id,
          currency: input.currency,
          ...value,
          createdAt: now,
        });
      } else {
        await ctx.db.patch(existing._id, value);
      }
    }
    for (const input of args.positions) {
      const existing = input.sourceId
        ? await ctx.db
            .query("financePositions")
            .withIndex("by_account_source_id", (q) =>
              q
                .eq("accountId", account._id)
                .eq("source", "snaptrade")
                .eq("sourceId", input.sourceId),
            )
            .unique()
        : await ctx.db
            .query("financePositions")
            .withIndex("by_account_symbol", (q) =>
              q.eq("accountId", account._id).eq("symbol", input.symbol),
            )
            .unique();
      const value = {
        accountId: account._id,
        source: "snaptrade" as const,
        sourceId: input.sourceId,
        symbol: input.symbol,
        name: input.name,
        quantity: parseProviderDecimal(input.quantity, "SnapTrade position quantity"),
        marketValue:
          input.marketValue === undefined
            ? undefined
            : parseProviderDecimal(input.marketValue, "SnapTrade market value"),
        averageCost:
          input.averageCost === undefined
            ? undefined
            : parseProviderDecimal(input.averageCost, "SnapTrade average cost"),
        currency: input.currency,
        observedAt: input.observedAt,
        updatedAt: now,
      };
      if (existing === null) {
        await ctx.db.insert("financePositions", {
          workspaceId: access.workspaceId,
          ...value,
        });
      } else {
        await ctx.db.patch(existing._id, value);
      }
    }
    for (const input of args.activities) {
      const existing = await ctx.db
        .query("financeActivities")
        .withIndex("by_workspace_source_fingerprint", (q) =>
          q
            .eq("workspaceId", access.workspaceId)
            .eq("source", "snaptrade")
            .eq("fingerprint", input.fingerprint),
        )
        .unique();
      const amount =
        input.amount === undefined
          ? undefined
          : parseProviderDecimal(input.amount, "SnapTrade activity amount");
      const value = {
        accountId: account._id,
        source: "snaptrade" as const,
        sourceId: input.sourceId,
        type: input.type,
        description: input.description,
        amount,
        currency: input.currency,
        symbol: input.symbol,
        quantity:
          input.quantity === undefined
            ? undefined
            : parseProviderDecimal(input.quantity, "SnapTrade activity quantity"),
        price:
          input.price === undefined
            ? undefined
            : parseProviderDecimal(input.price, "SnapTrade activity price"),
        fingerprint: input.fingerprint,
        status: input.status,
        occurredAt: input.occurredAt,
        settledAt: input.settledAt,
        updatedAt: now,
      };
      if (existing === null) {
        await ctx.db.insert("financeActivities", {
          workspaceId: access.workspaceId,
          ...value,
          createdAt: now,
        });
      } else {
        await ctx.db.patch(existing._id, value);
      }
      if (amount !== undefined) {
        // Mirrored ledger rows are fully derivable from provider activities:
        // one canonical row per fingerprint, converged by plain upsert. A
        // ledger poisoned by older promotion schemes is wiped with
        // purgeSnapTradeTransactions and rebuilt by the next full sync
        // instead of being adopted row by row.
        const dedupeKey = `snaptrade:activity:${input.fingerprint}`;
        const transaction = await ctx.db
          .query("financeTransactions")
          .withIndex("by_workspace_dedupe", (q) =>
            q.eq("workspaceId", access.workspaceId).eq("dedupeKey", dedupeKey),
          )
          .unique();
        const kind = input.type.toLowerCase();
        // Provider spends arrive with positive magnitudes; the ledger stores
        // outflows negative (a negative provider spend is a refund).
        const transactionAmount =
          kind === "spend" || kind === "fee"
            ? { ...amount, units: -amount.units }
            : amount;
        let categoryId: Id<"financeCategories"> | undefined;
        switch (kind) {
          case "contribution":
          case "deposit":
          case "withdrawal":
          case "transfer":
            categoryId = transfersCategoryId;
            break;
          case "buy":
          case "sell":
          case "tax":
          case "crypto_staking_action":
            categoryId = investingCategoryId;
            break;
        }
        const description = input.description ?? input.type;
        if (transaction === null) {
          await ctx.db.insert("financeTransactions", {
            workspaceId: access.workspaceId,
            accountId: account._id,
            source: "snaptrade",
            sourceId: input.sourceId,
            fingerprint: input.fingerprint,
            dedupeKey,
            description,
            amount: transactionAmount,
            currency: input.currency,
            postedAt: input.occurredAt,
            categoryId,
            status: input.status,
            createdAt: now,
            updatedAt: now,
          });
        } else {
          await ctx.db.patch(transaction._id, {
            amount: transactionAmount,
            categoryId,
            description,
            status: input.status,
            postedAt: input.occurredAt,
            updatedAt: now,
          });
        }
      }
    }
    for (const input of args.history) {
      const existing = await ctx.db
        .query("financeAccountValueHistory")
        .withIndex("by_account_date", (q) =>
          q.eq("accountId", account._id).eq("date", input.date),
        )
        .unique();
      const value = {
        source: "snaptrade" as const,
        equity: parseProviderDecimal(input.equity, "SnapTrade equity"),
        cash:
          input.cash === undefined
            ? undefined
            : parseProviderDecimal(input.cash, "SnapTrade history cash"),
        currency: input.currency,
        observedAt: input.observedAt,
        updatedAt: now,
      };
      if (existing === null) {
        await ctx.db.insert("financeAccountValueHistory", {
          workspaceId: access.workspaceId,
          accountId: account._id,
          date: input.date,
          ...value,
          createdAt: now,
        });
      } else {
        await ctx.db.patch(existing._id, value);
      }
    }
    for (const input of args.returnRates) {
      const existing = await ctx.db
        .query("financeAccountReturnRates")
        .withIndex("by_account_timeframe", (q) =>
          q.eq("accountId", account._id).eq("timeframe", input.timeframe),
        )
        .unique();
      const value = {
        source: "snaptrade" as const,
        returnPercent: input.returnPercent,
        asOf: input.asOf,
        observedAt: input.observedAt,
        updatedAt: now,
      };
      if (existing === null) {
        await ctx.db.insert("financeAccountReturnRates", {
          workspaceId: access.workspaceId,
          accountId: account._id,
          timeframe: input.timeframe,
          ...value,
          createdAt: now,
        });
      } else {
        await ctx.db.patch(existing._id, value);
      }
    }
    return {
      balances: args.balances.length,
      positions: args.positions.length,
      activities: args.activities.length,
      history: args.history.length,
      returnRates: args.returnRates.length,
    };
  },
});
