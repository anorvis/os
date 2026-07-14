import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireWorkspace } from "./lib/auth";

const manualSource = v.union(v.literal("manual"), v.literal("agent"));
const measurementFields = {
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
};
const macroFields = {
  birthdate: v.optional(v.string()),
  heightCm: v.optional(v.number()),
  weightKg: v.optional(v.number()),
  bodyFatPercent: v.optional(v.number()),
  sex: v.optional(v.string()),
  goal: v.optional(v.string()),
  trainingDaysPerWeek: v.optional(v.number()),
  activityLevel: v.optional(v.string()),
  targetCalories: v.optional(v.number()),
  proteinGrams: v.optional(v.number()),
  carbsGrams: v.optional(v.number()),
  fatGrams: v.optional(v.number()),
};
const exerciseInput = v.object({
  title: v.string(),
  muscleGroups: v.optional(v.array(v.string())),
  sets: v.array(
    v.object({
      setType: v.optional(v.string()),
      reps: v.optional(v.number()),
      weightKg: v.optional(v.number()),
      durationSeconds: v.optional(v.number()),
      distanceMeters: v.optional(v.number()),
    }),
  ),
});
const templateExerciseInput = v.object({
  title: v.string(),
  sets: v.array(
    v.object({
      reps: v.optional(v.number()),
      weightKg: v.optional(v.number()),
    }),
  ),
});

type DatabaseCtx = QueryCtx | MutationCtx;

function cleanRequired(value: string, label: string): string {
  const result = value.trim();
  if (!result) {
    throw new ConvexError({ code: "INVALID_INPUT", message: `${label} is required` });
  }
  return result;
}

function cleanOptional(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function requireNonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${label} must be a nonnegative number`,
    });
  }
  return value;
}

function validateOptionalNumbers(
  values: Record<string, string | number | undefined>,
): void {
  for (const [label, value] of Object.entries(values)) {
    if (typeof value === "number") requireNonnegative(value, label);
  }
}

async function owned<T extends "meals" | "bodyMeasurements" | "workouts" | "workoutTemplates">(
  ctx: DatabaseCtx,
  table: T,
  id: Id<T>,
  workspaceId: Id<"workspaces">,
): Promise<Doc<T>> {
  const document = await ctx.db.get(id);
  if (document === null || document.workspaceId !== workspaceId) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Health record not found" });
  }
  return document;
}

async function workoutDetails(ctx: QueryCtx, workout: Doc<"workouts">) {
  const exercises = await ctx.db
    .query("workoutExercises")
    .withIndex("by_workout_order", (q) => q.eq("workoutId", workout._id))
    .collect();
  return {
    ...workout,
    exercises: await Promise.all(
      exercises.map(async (exercise) => ({
        ...exercise,
        sets: await ctx.db
          .query("exerciseSets")
          .withIndex("by_exercise_order", (q) =>
            q.eq("workoutExerciseId", exercise._id),
          )
          .collect(),
      })),
    ),
  };
}

async function removeWorkoutChildren(
  ctx: MutationCtx,
  workoutId: Id<"workouts">,
): Promise<void> {
  const exercises = await ctx.db
    .query("workoutExercises")
    .withIndex("by_workout_order", (q) => q.eq("workoutId", workoutId))
    .collect();
  const sets = await ctx.db
    .query("exerciseSets")
    .withIndex("by_workout", (q) => q.eq("workoutId", workoutId))
    .collect();
  for (const set of sets) await ctx.db.delete(set._id);
  for (const exercise of exercises) await ctx.db.delete(exercise._id);
}

export const dashboard = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    dayStart: v.number(),
    dayEnd: v.number(),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const [meals, recentMeals, profile, measurement, measurementHistory, workouts, templates] =
      await Promise.all([
        ctx.db
          .query("meals")
          .withIndex("by_workspace_logged", (q) =>
            q
              .eq("workspaceId", access.workspaceId)
              .gte("loggedAt", args.dayStart)
              .lt("loggedAt", args.dayEnd),
          )
          .collect(),
        ctx.db
          .query("meals")
          .withIndex("by_workspace_logged", (q) =>
            q.eq("workspaceId", access.workspaceId),
          )
          .order("desc")
          .take(50),
        ctx.db
          .query("macroProfiles")
          .withIndex("by_workspace_active", (q) =>
            q.eq("workspaceId", access.workspaceId).eq("active", true),
          )
          .first(),
        ctx.db
          .query("bodyMeasurements")
          .withIndex("by_workspace_recorded", (q) =>
            q.eq("workspaceId", access.workspaceId),
          )
          .order("desc")
          .first(),
        ctx.db
          .query("bodyMeasurements")
          .withIndex("by_workspace_recorded", (q) =>
            q.eq("workspaceId", access.workspaceId),
          )
          .order("desc")
          .take(100),
        ctx.db
          .query("workouts")
          .withIndex("by_workspace_started", (q) =>
            q.eq("workspaceId", access.workspaceId),
          )
          .order("desc")
          .take(20),
        ctx.db
          .query("workoutTemplates")
          .withIndex("by_workspace_updated", (q) =>
            q.eq("workspaceId", access.workspaceId),
          )
          .order("desc")
          .collect(),
      ]);
    return {
      todayMeals: meals,
      recentMeals,
      macroProfile: profile,
      latestMeasurement: measurement,
      measurementHistory,
      recentWorkouts: await Promise.all(
        workouts.map((workout) => workoutDetails(ctx, workout)),
      ),
      workoutTemplates: templates,
    };
  },
});

export const saveMeal = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.optional(v.id("meals")),
    name: v.string(),
    mealType: v.string(),
    loggedAt: v.number(),
    calories: v.number(),
    proteinGrams: v.number(),
    carbsGrams: v.number(),
    fatGrams: v.number(),
    notes: v.optional(v.string()),
    source: v.optional(manualSource),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    validateOptionalNumbers({
      calories: args.calories,
      proteinGrams: args.proteinGrams,
      carbsGrams: args.carbsGrams,
      fatGrams: args.fatGrams,
    });
    const now = Date.now();
    const value = {
      name: cleanRequired(args.name, "Meal name"),
      mealType: cleanRequired(args.mealType, "Meal type"),
      loggedAt: args.loggedAt,
      calories: args.calories,
      proteinGrams: args.proteinGrams,
      carbsGrams: args.carbsGrams,
      fatGrams: args.fatGrams,
      notes: cleanOptional(args.notes),
      updatedAt: now,
    };
    if (args.id === undefined) {
      return ctx.db.insert("meals", {
        workspaceId: access.workspaceId,
        ...value,
        source: args.source ?? "manual",
        createdAt: now,
      });
    }
    const meal = await owned(ctx, "meals", args.id, access.workspaceId);
    await ctx.db.patch(meal._id, value);
    return meal._id;
  },
});

export const removeMeal = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")), id: v.id("meals") },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const meal = await owned(ctx, "meals", args.id, access.workspaceId);
    await ctx.db.delete(meal._id);
    return meal._id;
  },
});

export const saveMacroProfile = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")), ...macroFields },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const { workspaceId: _workspaceId, ...fields } = args;
    validateOptionalNumbers(fields);
    const activeProfiles = await ctx.db
      .query("macroProfiles")
      .withIndex("by_workspace_active", (q) =>
        q.eq("workspaceId", access.workspaceId).eq("active", true),
      )
      .collect();
    const now = Date.now();
    for (const profile of activeProfiles) {
      await ctx.db.patch(profile._id, { active: false, updatedAt: now });
    }
    return ctx.db.insert("macroProfiles", {
      workspaceId: access.workspaceId,
      active: true,
      ...fields,
      birthdate: cleanOptional(fields.birthdate),
      sex: cleanOptional(fields.sex),
      goal: cleanOptional(fields.goal),
      activityLevel: cleanOptional(fields.activityLevel),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const saveMeasurement = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.optional(v.id("bodyMeasurements")),
    recordedAt: v.number(),
    source: v.optional(manualSource),
    ...measurementFields,
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const {
      workspaceId: _workspaceId,
      id,
      source: inputSource,
      recordedAt,
      ...fields
    } = args;
    validateOptionalNumbers(fields);
    const now = Date.now();
    if (id === undefined) {
      return ctx.db.insert("bodyMeasurements", {
        workspaceId: access.workspaceId,
        source: inputSource ?? "manual",
        recordedAt,
        ...fields,
        createdAt: now,
        updatedAt: now,
      });
    }
    const measurement = await owned(
      ctx,
      "bodyMeasurements",
      id,
      access.workspaceId,
    );
    await ctx.db.patch(measurement._id, { recordedAt, ...fields, updatedAt: now });
    return measurement._id;
  },
});

export const measurementHistory = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 100), 1), 500);
    return ctx.db
      .query("bodyMeasurements")
      .withIndex("by_workspace_recorded", (q) =>
        q.eq("workspaceId", access.workspaceId),
      )
      .order("desc")
      .take(limit);
  },
});

export const saveWorkout = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.optional(v.id("workouts")),
    title: v.string(),
    startedAt: v.number(),
    durationSeconds: v.number(),
    notes: v.optional(v.string()),
    exercises: v.array(exerciseInput),
    source: v.optional(manualSource),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    requireNonnegative(args.durationSeconds, "Workout duration");
    if (args.exercises.length > 100) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Workout has too many exercises" });
    }
    const setCount = args.exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0);
    if (setCount > 500) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Workout has too many sets" });
    }
    const now = Date.now();
    let workoutId = args.id;
    if (workoutId === undefined) {
      workoutId = await ctx.db.insert("workouts", {
        workspaceId: access.workspaceId,
        source: args.source ?? "manual",
        title: cleanRequired(args.title, "Workout title"),
        startedAt: args.startedAt,
        durationSeconds: args.durationSeconds,
        notes: cleanOptional(args.notes),
        createdAt: now,
        updatedAt: now,
      });
    } else {
      const workout = await owned(ctx, "workouts", workoutId, access.workspaceId);
      await removeWorkoutChildren(ctx, workout._id);
      await ctx.db.patch(workout._id, {
        title: cleanRequired(args.title, "Workout title"),
        startedAt: args.startedAt,
        durationSeconds: args.durationSeconds,
        notes: cleanOptional(args.notes),
        updatedAt: now,
      });
    }
    for (const [exerciseOrder, exercise] of args.exercises.entries()) {
      const exerciseId = await ctx.db.insert("workoutExercises", {
        workspaceId: access.workspaceId,
        workoutId,
        title: cleanRequired(exercise.title, "Exercise title"),
        muscleGroups: exercise.muscleGroups ?? [],
        order: exerciseOrder,
      });
      for (const [setOrder, set] of exercise.sets.entries()) {
        validateOptionalNumbers(set);
        await ctx.db.insert("exerciseSets", {
          workspaceId: access.workspaceId,
          workoutId,
          workoutExerciseId: exerciseId,
          setType: cleanOptional(set.setType) ?? "normal",
          reps: set.reps,
          weightKg: set.weightKg,
          durationSeconds: set.durationSeconds,
          distanceMeters: set.distanceMeters,
          order: setOrder,
        });
      }
    }
    return workoutId;
  },
});

export const getWorkout = query({
  args: { workspaceId: v.optional(v.id("workspaces")), id: v.id("workouts") },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const workout = await owned(ctx, "workouts", args.id, access.workspaceId);
    return workoutDetails(ctx, workout);
  },
});

export const removeWorkout = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")), id: v.id("workouts") },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const workout = await owned(ctx, "workouts", args.id, access.workspaceId);
    await removeWorkoutChildren(ctx, workout._id);
    await ctx.db.delete(workout._id);
    return workout._id;
  },
});

export const saveWorkoutTemplate = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.optional(v.id("workoutTemplates")),
    name: v.string(),
    exercises: v.array(templateExerciseInput),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    if (args.exercises.length > 100) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Workout template has too many exercises",
      });
    }
    const setCount = args.exercises.reduce(
      (sum, exercise) => sum + exercise.sets.length,
      0,
    );
    if (setCount > 500) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Workout template has too many sets",
      });
    }
    const now = Date.now();
    let templateId = args.id;
    if (templateId === undefined) {
      templateId = await ctx.db.insert("workoutTemplates", {
        workspaceId: access.workspaceId,
        name: cleanRequired(args.name, "Template name"),
        createdAt: now,
        updatedAt: now,
      });
    } else {
      const template = await owned(
        ctx,
        "workoutTemplates",
        templateId,
        access.workspaceId,
      );
      const sets = await ctx.db
        .query("workoutTemplateSets")
        .withIndex("by_template", (q) => q.eq("templateId", template._id))
        .collect();
      const exercises = await ctx.db
        .query("workoutTemplateExercises")
        .withIndex("by_template_order", (q) => q.eq("templateId", template._id))
        .collect();
      for (const set of sets) await ctx.db.delete(set._id);
      for (const exercise of exercises) await ctx.db.delete(exercise._id);
      await ctx.db.patch(template._id, {
        name: cleanRequired(args.name, "Template name"),
        updatedAt: now,
      });
    }
    for (const [exerciseOrder, exercise] of args.exercises.entries()) {
      const exerciseId = await ctx.db.insert("workoutTemplateExercises", {
        workspaceId: access.workspaceId,
        templateId,
        title: cleanRequired(exercise.title, "Exercise title"),
        order: exerciseOrder,
      });
      for (const [setOrder, set] of exercise.sets.entries()) {
        validateOptionalNumbers(set);
        await ctx.db.insert("workoutTemplateSets", {
          workspaceId: access.workspaceId,
          templateId,
          exerciseId,
          reps: set.reps,
          weightKg: set.weightKg,
          order: setOrder,
        });
      }
    }
    return templateId;
  },
});

export const listWorkoutTemplates = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const templates = await ctx.db
      .query("workoutTemplates")
      .withIndex("by_workspace_updated", (q) =>
        q.eq("workspaceId", access.workspaceId),
      )
      .order("desc")
      .take(100);
    return Promise.all(
      templates.map(async (template) => {
        const exercises = await ctx.db
          .query("workoutTemplateExercises")
          .withIndex("by_template_order", (q) =>
            q.eq("templateId", template._id),
          )
          .collect();
        return {
          ...template,
          exercises: await Promise.all(
            exercises.map(async (exercise) => ({
              ...exercise,
              sets: await ctx.db
                .query("workoutTemplateSets")
                .withIndex("by_exercise_order", (q) =>
                  q.eq("exerciseId", exercise._id),
                )
                .collect(),
            })),
          ),
        };
      }),
    );
  },
});
