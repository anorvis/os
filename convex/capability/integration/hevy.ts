"use node";

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { action, type ActionCtx, internalAction } from "../../_generated/server";
import { decryptCredentials, encryptCredentials } from "../../platform/auth/credentials";
type HevyConnection = Extract<Doc<"providerConnections">, { provider: "hevy" }>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function getJson(url: string, apiKey: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { "api-key": apiKey } });
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    throw new Error(`Hevy request failed (${response.status}): ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return record(payload) ?? {};
}

function parseWorkout(value: unknown) {
  const workout = record(value);
  if (!workout) return undefined;
  const sourceId = string(workout.id);
  const title = string(workout.title);
  const startedAt = Date.parse(string(workout.start_time) ?? "");
  if (!sourceId || !title || !Number.isFinite(startedAt)) return undefined;
  const endedAt = Date.parse(string(workout.end_time) ?? "");
  const exercises = Array.isArray(workout.exercises)
    ? workout.exercises.flatMap((item) => {
        const exercise = record(item);
        const exerciseTitle = string(exercise?.title);
        if (!exercise || !exerciseTitle) return [];
        const muscleGroups = [
          string(exercise.muscle_group),
          ...(Array.isArray(exercise.secondary_muscle_groups)
            ? exercise.secondary_muscle_groups.flatMap((group) => string(group) ?? [])
            : []),
        ].flatMap((group) => group ?? []);
        const sets = Array.isArray(exercise.sets)
          ? exercise.sets.flatMap((setValue) => {
              const set = record(setValue);
              if (!set) return [];
              return [
                {
                  setType: string(set.type) ?? "normal",
                  reps: number(set.reps),
                  weightKg: number(set.weight_kg),
                  durationSeconds: number(set.duration_seconds),
                  distanceMeters: number(set.distance_meters),
                },
              ];
            })
          : [];
        return [{ title: exerciseTitle, muscleGroups, sets }];
      })
    : [];
  return {
    sourceId,
    title,
    startedAt,
    durationSeconds: Number.isFinite(endedAt)
      ? Math.max(0, Math.round((endedAt - startedAt) / 1000))
      : 0,
    notes: string(workout.description),
    exercises,
  };
}

function parseMeasurement(value: unknown) {
  const measurement = record(value);
  if (!measurement) return undefined;
  const date = string(measurement.date);
  if (!date) return undefined;
  const recordedAt = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : date,
  );
  if (!Number.isFinite(recordedAt)) return undefined;
  return {
    sourceId: date,
    recordedAt,
    weightKg: number(measurement.weight_kg),
    leanMassKg: number(measurement.lean_mass_kg),
    fatPercent: number(measurement.fat_percent),
    neckCm: number(measurement.neck_cm),
    shoulderCm: number(measurement.shoulder_cm),
    chestCm: number(measurement.chest_cm),
    leftBicepCm: number(measurement.left_bicep_cm),
    rightBicepCm: number(measurement.right_bicep_cm),
    leftForearmCm: number(measurement.left_forearm_cm),
    rightForearmCm: number(measurement.right_forearm_cm),
    abdomenCm: number(measurement.abdomen),
    waistCm: number(measurement.waist),
    hipsCm: number(measurement.hips),
    leftThighCm: number(measurement.left_thigh),
    rightThighCm: number(measurement.right_thigh),
    leftCalfCm: number(measurement.left_calf),
    rightCalfCm: number(measurement.right_calf),
  };
}

export const settings = action({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args): Promise<{
    connected: boolean;
    hasApiKey: boolean;
    lastCheckedAt: string | null;
    secretProvider: string | null;
  }> => {
    const connection = (await ctx.runQuery(internal.capability.integration.connection, {
      workspaceId: args.workspaceId,
      provider: "hevy",
    })) as HevyConnection | null;
    return {
      connected: connection?.status === "connected",
      hasApiKey: connection?.credentials !== undefined,
      lastCheckedAt: connection?.updatedAt
        ? new Date(connection.updatedAt).toISOString()
        : null,
      secretProvider: connection?.credentials ? "convex" : null,
    };
  },
});

export const saveSettings = action({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    apiKey: v.string(),
  },
  handler: async (ctx, args) => {
    const apiKey = args.apiKey.trim();
    if (!apiKey) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Hevy API key is required" });
    }
    await ctx.runMutation(internal.capability.integration.saveHevyCredentials, {
      workspaceId: args.workspaceId,
      credentials: encryptCredentials({ apiKey }),
    });
    return { connected: true };
  },
});

export const syncNow = action({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const workspaceId: Id<"workspaces"> = await ctx.runQuery(
      internal.capability.integration.authorizeWorkspace,
      { workspaceId: args.workspaceId },
    );
    let cursor: string | undefined;
    let workoutsFetched = 0;
    let workoutsCreated = 0;
    let workoutsUpdated = 0;
    let measurementsFetched = 0;
    let measurementsCreated = 0;
    let measurementsUpdated = 0;
    let completed = false;
    let watermark: string | undefined;
    for (let guard = 0; guard < 200; guard += 1) {
      const result: ProviderStepResult = await ctx.runAction(
        internal.capability.integration.hevy.syncScheduledStep,
        { workspaceId, cursor, mode: "full" },
      );
      const syncingMeasurements = cursor?.includes("\"measurements\"") ?? false;
      if (syncingMeasurements) {
        measurementsFetched += result.fetched;
        measurementsCreated += result.created;
        measurementsUpdated += result.updated;
      } else {
        workoutsFetched += result.fetched;
        workoutsCreated += result.created;
        workoutsUpdated += result.updated;
      }
      if (result.done) {
        completed = true;
        watermark = result.watermark;
        break;
      }
      cursor = result.cursor;
      if (!cursor) break;
    }
    if (completed) {
      await ctx.runMutation(
        internal.capability.integration.jobs.publishProviderSyncCompletion,
        { workspaceId, provider: "hevy", watermark },
      );
    }
    return {
      fetched: workoutsFetched,
      created: workoutsCreated,
      updated: workoutsUpdated,
      measurementsFetched,
      measurementsCreated,
      measurementsUpdated,
    };
  },
});

async function access(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces"> | undefined,
): Promise<{ workspaceId: Id<"workspaces">; apiKey: string }> {
  const id: Id<"workspaces"> = await ctx.runQuery(
    internal.capability.integration.authorizeWorkspace,
    { workspaceId },
  );
  const connection = await ctx.runQuery(
    internal.capability.integration.connectionByWorkspace,
    { workspaceId: id, provider: "hevy" },
  );
  if (connection?.provider !== "hevy" || connection.credentials === undefined) {
    throw new ConvexError({ code: "NOT_CONNECTED", message: "Hevy is not connected" });
  }
  const apiKey = decryptCredentials(connection.credentials).apiKey;
  if (!apiKey) throw new Error("Hevy API key is missing");
  return { workspaceId: id, apiKey };
}

function nullableNumber(value: unknown): number | null {
  return number(value) ?? null;
}

function nullableString(value: unknown): string | null {
  return string(value) ?? null;
}

function routine(value: unknown) {
  const row = record(value);
  const id = string(row?.id);
  const title = string(row?.title);
  if (!row || !id || !title) return null;
  const exercises = Array.isArray(row.exercises)
    ? row.exercises.flatMap((value) => {
        const exercise = record(value);
        const exerciseTitle = string(exercise?.title);
        const exerciseTemplateId = string(exercise?.exercise_template_id);
        if (!exercise || !exerciseTitle || !exerciseTemplateId) return [];
        const sets = Array.isArray(exercise.sets)
          ? exercise.sets.flatMap((value) => {
              const set = record(value);
              if (!set) return [];
              const range = record(set.rep_range);
              return [{
                type: string(set.type) ?? "normal",
                reps: nullableNumber(set.reps),
                weightKg: nullableNumber(set.weight_kg),
                durationSeconds: nullableNumber(set.duration_seconds),
                distanceMeters: nullableNumber(set.distance_meters),
                customMetric: nullableNumber(set.custom_metric),
                repRange: range
                  ? {
                      start: nullableNumber(range.start),
                      end: nullableNumber(range.end),
                    }
                  : null,
              }];
            })
          : [];
        return [{
          title: exerciseTitle,
          exerciseTemplateId,
          restSeconds: nullableNumber(exercise.rest_seconds),
          notes: nullableString(exercise.notes),
          supersetId:
            nullableNumber(exercise.superset_id) ??
            nullableNumber(exercise.supersets_id),
          sets,
        }];
      })
    : [];
  return {
    id,
    title,
    updatedAt: nullableString(row.updated_at),
    exercises,
  };
}

async function request(
  url: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "api-key": apiKey,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new ConvexError({
      code: "PROVIDER_ERROR",
      message: `Hevy request failed: ${response.status}`,
    });
  }
  const payload = record(await response.json());
  if (!payload) throw new Error("Hevy returned an invalid response");
  return payload;
}

export const listRoutines = action({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const { apiKey } = await access(ctx, args.workspaceId);
    const routines = [];
    for (let page = 1; page <= 200; page += 1) {
      const payload = await request(
        `https://api.hevyapp.com/v1/routines?page=${page}&pageSize=10`,
        apiKey,
      );
      const values = Array.isArray(payload.routines) ? payload.routines : [];
      routines.push(...values.flatMap((value) => routine(value) ?? []));
      const pageCount = number(payload.page_count) ?? page;
      if (values.length < 10 || page >= pageCount) break;
    }
    return { routines };
  },
});

export const listExerciseTemplates = action({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const { apiKey } = await access(ctx, args.workspaceId);
    const exerciseTemplates: Array<{ id: string; title: string }> = [];
    for (let page = 1; page <= 200; page += 1) {
      const payload = await request(
        `https://api.hevyapp.com/v1/exercise_templates?page=${page}&pageSize=100`,
        apiKey,
      );
      const values = Array.isArray(payload.exercise_templates)
        ? payload.exercise_templates
        : [];
      for (const value of values) {
        const row = record(value);
        const id = string(row?.id);
        const title = string(row?.title);
        if (id && title) exerciseTemplates.push({ id, title });
      }
      const pageCount = number(payload.page_count) ?? page;
      if (values.length < 100 || page >= pageCount) break;
    }
    return { exerciseTemplates };
  },
});

export const saveRoutine = action({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    routine: v.any(),
  },
  handler: async (ctx, args) => {
    const { apiKey } = await access(ctx, args.workspaceId);
    const value = record(args.routine);
    const id = string(value?.id);
    const title = string(value?.title);
    const exercises = Array.isArray(value?.exercises) ? value.exercises : null;
    if (!id || !title || !exercises || exercises.length === 0) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Hevy routine is invalid" });
    }
    const encodedExercises = exercises.map((item) => {
      const exercise = record(item);
      const exerciseTemplateId = string(exercise?.exerciseTemplateId);
      const sets = Array.isArray(exercise?.sets) ? exercise.sets : [];
      if (!exerciseTemplateId || sets.length === 0) {
        throw new ConvexError({ code: "INVALID_INPUT", message: "Hevy routine exercise is invalid" });
      }
      return {
        exercise_template_id: exerciseTemplateId,
        superset_id: nullableNumber(exercise?.supersetId),
        rest_seconds: nullableNumber(exercise?.restSeconds),
        notes: nullableString(exercise?.notes),
        sets: sets.map((item) => {
          const set = record(item);
          if (!set) {
            throw new ConvexError({ code: "INVALID_INPUT", message: "Hevy routine set is invalid" });
          }
          return {
            type: string(set.type) ?? "normal",
            weight_kg: nullableNumber(set.weightKg),
            reps: nullableNumber(set.reps),
            distance_meters: nullableNumber(set.distanceMeters),
            duration_seconds: nullableNumber(set.durationSeconds),
            custom_metric: nullableNumber(set.customMetric),
            rep_range: set.repRange ?? null,
          };
        }),
      };
    });
    const payload = await request(
      `https://api.hevyapp.com/v1/routines/${encodeURIComponent(id)}`,
      apiKey,
      {
        method: "PUT",
        body: JSON.stringify({ routine: { title, exercises: encodedExercises } }),
      },
    );
    const saved = routine(payload.routine ?? payload);
    if (!saved) throw new Error("Hevy returned an invalid routine");
    return saved;
  },
});


type ProviderStepResult = {
  done: boolean;
  cursor?: string;
  watermark?: string;
  fetched: number;
  applied: number;
  skipped: number;
  created: number;
  updated: number;
};

function replaySince(watermark: string): string {
  const numeric = Number(watermark);
  if (/^-?\d+(?:\.\d+)?$/.test(watermark) && Number.isFinite(numeric)) {
    return String(Math.max(0, numeric - 5 * 60 * 1000));
  }
  const parsed = Date.parse(watermark);
  if (Number.isFinite(parsed)) {
    return new Date(parsed - 5 * 60 * 1000).toISOString();
  }
  return watermark;
}

function eventValues(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.events)) return payload.events;
  if (Array.isArray(payload.workout_events)) return payload.workout_events;
  const values: unknown[] = [];
  for (const key of ["created", "updated"]) {
    const items = payload[key];
    if (!Array.isArray(items)) continue;
    for (const workout of items as unknown[]) values.push({ type: key, workout });
  }
  for (const key of ["deleted", "deleted_workout_ids", "deleted_ids"]) {
    const items = payload[key];
    if (!Array.isArray(items)) continue;
    for (const deleted of items as unknown[]) {
      values.push(
        typeof deleted === "string"
          ? { type: "deleted", workout_id: deleted }
          : { type: "deleted", workout: deleted },
      );
    }
  }
  return values;
}

function eventWatermark(value: unknown): string | undefined {
  const row = record(value);
  if (!row) return undefined;
  let watermark: string | undefined;
  const nested = record(row.workout ?? row.data ?? row.payload);
  for (const [candidateRow, keys] of [
    [
      row,
      [
        "watermark",
        "cursor",
        "occurred_at",
        "deleted_at",
        "created_at",
        "updated_at",
        "timestamp",
      ],
    ],
    [nested, ["updated_at", "created_at", "start_time"]],
  ] as const) {
    if (!candidateRow) continue;
    for (const key of keys) {
      const candidate =
        string(candidateRow[key]) ?? number(candidateRow[key])?.toString();
      const time = candidate === undefined ? Number.NaN : Date.parse(candidate);
      watermark = maxWatermark(
        watermark,
        Number.isFinite(time) ? new Date(time).toISOString() : candidate,
      );
    }
  }
  return watermark;
}

function maxWatermark(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  const currentNumeric = Number(current);
  const candidateNumeric = Number(candidate);
  if (
    /^-?\d+(?:\.\d+)?$/.test(current) &&
    /^-?\d+(?:\.\d+)?$/.test(candidate) &&
    Number.isFinite(currentNumeric) &&
    Number.isFinite(candidateNumeric)
  ) {
    return candidateNumeric >= currentNumeric ? candidate : current;
  }
  const currentTime = Date.parse(current);
  const candidateTime = Date.parse(candidate);
  if (Number.isFinite(currentTime) && Number.isFinite(candidateTime)) {
    return candidateTime >= currentTime ? candidate : current;
  }
  return candidate >= current ? candidate : current;
}

export const syncScheduledStep = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    cursor: v.optional(v.string()),
    mode: v.optional(v.union(v.literal("full"), v.literal("live"))),
  },
  handler: async (ctx, args): Promise<ProviderStepResult> => {
    const connection = await ctx.runQuery(
      internal.capability.integration.connectionByWorkspace,
      { workspaceId: args.workspaceId, provider: "hevy" },
    );
    if (connection?.provider !== "hevy" || connection.credentials === undefined) {
      throw new ConvexError({ code: "NOT_CONNECTED", message: "Hevy is not connected" });
    }
    const apiKey = decryptCredentials(connection.credentials).apiKey;
    if (!apiKey) throw new Error("Hevy API key is missing");

    if (args.mode === "live" || args.cursor?.includes("\"mode\":\"live\"")) {
      const persisted = args.cursor
        ? undefined
        : await ctx.runQuery(internal.capability.integration.providerSyncState, {
            workspaceId: args.workspaceId,
            provider: "hevy",
          });
      const state = args.cursor
        ? (JSON.parse(args.cursor) as {
            mode: "live";
            page: number;
            since: string;
            watermark?: string;
            descending?: boolean;
          })
        : persisted?.watermark
          ? {
              mode: "live" as const,
              page: 1,
              since: replaySince(persisted.watermark),
              watermark: persisted.watermark,
              descending: false,
            }
          : null;
      if (state === null) {
        return {
          done: true,
          fetched: 0,
          applied: 0,
          skipped: 0,
          created: 0,
          updated: 0,
        };
      }
      const payload = await getJson(
        `https://api.hevyapp.com/v1/workouts/events?since=${encodeURIComponent(state.since)}&page=${state.page}&pageSize=10`,
        apiKey,
      );
      const values = eventValues(payload);
      const payloadWatermark =
        string(payload.watermark) ??
        number(payload.watermark)?.toString() ??
        string(payload.next_since) ??
        number(payload.next_since)?.toString() ??
        string(payload.next_cursor) ??
        number(payload.next_cursor)?.toString();
      let candidateWatermark = maxWatermark(state.watermark, payloadWatermark);
      for (const value of values) {
        candidateWatermark = maxWatermark(candidateWatermark, eventWatermark(value));
      }
      const pageCount = Math.max(1, number(payload.page_count) ?? 1);
      if (!state.descending && state.page === 1 && pageCount > 1) {
        return {
          done: false,
          cursor: JSON.stringify({
            mode: "live",
            page: pageCount,
            since: state.since,
            watermark: candidateWatermark,
            descending: true,
          }),
          watermark: candidateWatermark,
          fetched: 0,
          applied: 0,
          created: 0,
          updated: 0,
          skipped: 0,
        };
      }

      let created = 0;
      let updated = 0;
      let deletedCount = 0;
      let skipped = 0;
      for (const value of [...values].reverse()) {
        const event = record(value);
        if (!event) {
          skipped += 1;
          continue;
        }
        const eventType =
          string(event.type)?.toLowerCase() ??
          string(event.event_type)?.toLowerCase() ??
          string(event.action)?.toLowerCase() ??
          string(event.kind)?.toLowerCase() ??
          "";
        const isDeleted =
          event.deleted === true ||
          eventType.includes("delete") ||
          eventType === "workout_removed";
        const workoutValue = event.workout ?? event.data ?? event.payload ?? event;
        const workout = record(workoutValue);
        const sourceId =
          string(event.workout_id) ??
          string(event.workoutId) ??
          string(workout?.id) ??
          string(workoutValue) ??
          string(event.id);
        const parsed = isDeleted ? undefined : parseWorkout(workoutValue);
        if ((!isDeleted && parsed === undefined) || (isDeleted && sourceId === undefined)) {
          skipped += 1;
          continue;
        }
        const counts: {
          created: number;
          updated: number;
          deleted: number;
          skipped: number;
        } = await ctx.runMutation(
          internal.capability.integration.applyHevyLiveWorkouts,
          {
            workspaceId: args.workspaceId,
            system: true,
            workouts: parsed ? [parsed] : [],
            deletedSourceIds: isDeleted && sourceId ? [sourceId] : [],
          },
        );
        created += counts.created;
        updated += counts.updated;
        deletedCount += counts.deleted;
        skipped += counts.skipped;
      }
      const more = state.descending === true && state.page > 1;
      return {
        done: !more,
        cursor: more
          ? JSON.stringify({
              mode: "live",
              page: state.page - 1,
              since: state.since,
              watermark: candidateWatermark,
              descending: true,
            })
          : undefined,
        watermark: candidateWatermark,
        fetched: values.length,
        applied: created + updated + deletedCount,
        created,
        updated: updated + deletedCount,
        skipped,
      };
    }

    const state = args.cursor
      ? (JSON.parse(args.cursor) as {
          kind: "workouts" | "measurements";
          page: number;
          watermark?: string;
        })
      : {
          kind: "workouts" as const,
          page: 1,
          watermark: new Date().toISOString(),
        };
    if (state.kind === "workouts") {
      const payload = await getJson(
        `https://api.hevyapp.com/v1/workouts?page=${state.page}&pageSize=10`,
        apiKey,
      );
      const values = Array.isArray(payload.workouts) ? payload.workouts : [];
      const workouts = values.flatMap((value) => parseWorkout(value) ?? []);
      const counts: { created: number; updated: number; skipped?: number } =
        await ctx.runMutation(internal.capability.integration.upsertHevyWorkouts, {
          workspaceId: args.workspaceId,
          system: true,
          workouts,
        });
      const pageCount = number(payload.page_count) ?? state.page;
      const more = values.length === 10 && state.page < pageCount;
      return {
        done: false,
        cursor: JSON.stringify(
          more
            ? { kind: "workouts", page: state.page + 1, watermark: state.watermark }
            : { kind: "measurements", page: 1, watermark: state.watermark },
        ),
        watermark: state.watermark,
        fetched: values.length,
        applied: counts.created + counts.updated,
        created: counts.created,
        updated: counts.updated,
        skipped: values.length - workouts.length + (counts.skipped ?? 0),
      };
    }
    const payload = await getJson(
      `https://api.hevyapp.com/v1/body_measurements?page=${state.page}&pageSize=10`,
      apiKey,
    );
    const values = Array.isArray(payload.body_measurements)
      ? payload.body_measurements
      : [];
    const measurements = values.flatMap((value) => parseMeasurement(value) ?? []);
    const counts: { created: number; updated: number } =
      await ctx.runMutation(internal.capability.integration.upsertHevyMeasurements, {
        workspaceId: args.workspaceId,
        system: true,
        measurements,
      });
    const pageCount = number(payload.page_count) ?? state.page;
    const more = values.length === 10 && state.page < pageCount;
    return {
      done: !more,
      cursor: more
        ? JSON.stringify({
            kind: "measurements",
            page: state.page + 1,
            watermark: state.watermark,
          })
        : undefined,
      watermark: state.watermark,
      fetched: values.length,
      applied: counts.created + counts.updated,
      created: counts.created,
      updated: counts.updated,
      skipped: values.length - measurements.length,
    };
  },
});
