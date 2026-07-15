import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { requireWorkspace } from "../platform/auth/access";
import { cancelActiveSyncs, enqueueSync } from "./integration/jobs";
import { parseDecimal } from "./finance/decimal";

const provider = v.union(
  v.literal("google"),
  v.literal("pinterest"),
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
    return connections.map(({ credentials, ...connection }) => ({
      ...connection,
      hasCredentials: credentials !== undefined,
    }));
  },
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

// The user-visible tag every synced Google event carries. The lifeTags row is
// keyed by systemKey so renames are impossible and the tag survives hides only
// through explicit backend seeding, never by name-matching a user tag.
const GOOGLE_TAG = {
  systemKey: "google-calendar",
  name: "Google Calendar",
  color: "#4285f4",
} as const;

async function ensureGoogleTag(
  ctx: { db: MutationCtx["db"] },
  workspaceId: Id<"workspaces">,
): Promise<string> {
  const existing = await ctx.db
    .query("lifeTags")
    .withIndex("by_workspace_system", (q) =>
      q.eq("workspaceId", workspaceId).eq("systemKey", GOOGLE_TAG.systemKey),
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
  let name: string = GOOGLE_TAG.name;
  for (let suffix = 0; ; suffix += 1) {
    if (suffix > 0) name = `${GOOGLE_TAG.name} (integration${suffix > 1 ? ` ${suffix}` : ""})`;
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
    color: GOOGLE_TAG.color,
    hidden: false,
    systemKey: GOOGLE_TAG.systemKey,
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
    const tag = await ensureGoogleTag(ctx, access.workspaceId);
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
      const tag = await ensureGoogleTag(ctx, workspace._id);
      for (const event of events) {
        if (event.tag === tag) continue;
        await ctx.db.patch(event._id, { tag, updatedAt: Date.now() });
        tagged += 1;
      }
    }
    return { tagged };
  },
});

export const upsertHevyWorkouts = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    system: v.optional(v.boolean()),
    workouts: v.array(
      v.object({
        sourceId: v.string(),
        title: v.string(),
        startedAt: v.number(),
        durationSeconds: v.number(),
        notes: v.optional(v.string()),
        exercises: v.array(hevyExercise),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const access = args.system
      ? { workspaceId: args.workspaceId! }
      : await requireWorkspace(ctx, args.workspaceId);
    let created = 0;
    let updated = 0;
    for (const input of args.workouts) {
      const existing = await ctx.db
        .query("workouts")
        .withIndex("by_workspace_source_id", (q) =>
          q
            .eq("workspaceId", access.workspaceId)
            .eq("source", "hevy")
            .eq("sourceId", input.sourceId),
        )
        .unique();
      const now = Date.now();
      let workoutId: Id<"workouts">;
      if (existing === null) {
        workoutId = await ctx.db.insert("workouts", {
          workspaceId: access.workspaceId,
          source: "hevy",
          sourceId: input.sourceId,
          title: input.title,
          startedAt: input.startedAt,
          durationSeconds: input.durationSeconds,
          notes: input.notes,
          createdAt: now,
          updatedAt: now,
        });
        created += 1;
      } else {
        workoutId = existing._id;
        updated += 1;
        const [exercises, sets] = await Promise.all([
          ctx.db
            .query("workoutExercises")
            .withIndex("by_workout_order", (q) => q.eq("workoutId", workoutId))
            .collect(),
          ctx.db
            .query("exerciseSets")
            .withIndex("by_workout", (q) => q.eq("workoutId", workoutId))
            .collect(),
        ]);
        for (const set of sets) await ctx.db.delete(set._id);
        for (const exercise of exercises) await ctx.db.delete(exercise._id);
        await ctx.db.patch(workoutId, {
          title: input.title,
          startedAt: input.startedAt,
          durationSeconds: input.durationSeconds,
          notes: input.notes,
          updatedAt: now,
        });
      }
      for (const [order, exercise] of input.exercises.entries()) {
        const exerciseId = await ctx.db.insert("workoutExercises", {
          workspaceId: access.workspaceId,
          workoutId,
          title: exercise.title,
          muscleGroups: exercise.muscleGroups,
          order,
        });
        for (const [setOrder, set] of exercise.sets.entries()) {
          await ctx.db.insert("exerciseSets", {
            workspaceId: access.workspaceId,
            workoutId,
            workoutExerciseId: exerciseId,
            ...set,
            order: setOrder,
          });
        }
      }
    }
    return { created, updated };
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
            : parseDecimal(input.balance, "SnapTrade balance"),
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
            : parseDecimal(input.cash, "SnapTrade cash balance"),
        buyingPower:
          input.buyingPower === undefined
            ? undefined
            : parseDecimal(input.buyingPower, "SnapTrade buying power"),
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
        quantity: parseDecimal(input.quantity, "SnapTrade position quantity"),
        marketValue:
          input.marketValue === undefined
            ? undefined
            : parseDecimal(input.marketValue, "SnapTrade market value"),
        averageCost:
          input.averageCost === undefined
            ? undefined
            : parseDecimal(input.averageCost, "SnapTrade average cost"),
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
          : parseDecimal(input.amount, "SnapTrade activity amount");
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
            : parseDecimal(input.quantity, "SnapTrade activity quantity"),
        price:
          input.price === undefined
            ? undefined
            : parseDecimal(input.price, "SnapTrade activity price"),
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
        const dedupeKey = `snaptrade:activity:${input.fingerprint}`;
        const transaction = await ctx.db
          .query("financeTransactions")
          .withIndex("by_workspace_dedupe", (q) =>
            q.eq("workspaceId", access.workspaceId).eq("dedupeKey", dedupeKey),
          )
          .unique();
        if (transaction === null) {
          await ctx.db.insert("financeTransactions", {
            workspaceId: access.workspaceId,
            accountId: account._id,
            source: "snaptrade",
            sourceId: input.sourceId,
            fingerprint: input.fingerprint,
            dedupeKey,
            description: input.description ?? input.type,
            amount,
            currency: input.currency,
            postedAt: input.occurredAt,
            status: input.status,
            createdAt: now,
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
        equity: parseDecimal(input.equity, "SnapTrade equity"),
        cash:
          input.cash === undefined
            ? undefined
            : parseDecimal(input.cash, "SnapTrade history cash"),
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
