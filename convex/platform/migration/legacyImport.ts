import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { internal } from "../../_generated/api";
import { ConvexError, v } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import { mutation, type MutationCtx } from "../../_generated/server";
import { requireOwner } from "../auth/access";
import { parseDecimal } from "../../capability/finance/decimal";

const encryptedCredentials = v.object({
  algorithm: v.literal("aes-256-gcm"),
  keyVersion: v.number(),
  nonce: v.string(),
  ciphertext: v.string(),
});

const source = v.union(
  v.literal("manual"),
  v.literal("agent"),
  v.literal("import"),
  v.literal("google"),
  v.literal("hevy"),
  v.literal("snaptrade"),
  v.literal("csv"),
  v.literal("url"),
  v.literal("themealdb"),
);

const maybeString = v.optional(v.string());
const maybeNumber = v.optional(v.number());
const legacyStamp = {
  legacyId: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
};
const task = v.object({
  ...legacyStamp,
  title: v.string(),
  notes: maybeString,
  status: v.union(v.literal("open"), v.literal("in_progress"), v.literal("completed"), v.literal("cancelled")),
  priority: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"))),
  dueAt: maybeNumber,
  source,
  sourceId: maybeString,
  durationMinutes: maybeNumber,
  links: v.array(v.string()),
  multiSession: v.boolean(),
  completedAt: maybeNumber,
});
const taskSession = v.object({
  ...legacyStamp,
  taskLegacyId: v.string(),
  startAt: v.number(),
  endAt: v.number(),
  status: v.union(v.literal("planned"), v.literal("completed"), v.literal("cancelled")),
  source,
});
const calendarEvent = v.object({
  ...legacyStamp,
  summary: v.string(),
  startAt: v.number(),
  endAt: v.number(),
  location: maybeString,
  description: maybeString,
  tag: maybeString,
  source,
  readOnly: v.boolean(),
  provider: v.string(),
  providerEventId: maybeString,
  calendarId: maybeString,
  allDay: v.boolean(),
  timezone: maybeString,
  sourceHash: maybeString,
});
const lifeTag = v.object({ ...legacyStamp, name: v.string(), normalizedName: v.string(), color: maybeString, hidden: v.boolean(), systemKey: maybeString });
const meal = v.object({ ...legacyStamp, legacyId: v.string(), name: v.string(), mealType: v.string(), loggedAt: v.number(), calories: v.number(), proteinGrams: v.number(), carbsGrams: v.number(), fatGrams: v.number(), source, notes: maybeString });
const macroProfile = v.object({ ...legacyStamp, active: v.boolean(), birthdate: maybeString, heightCm: maybeNumber, weightKg: maybeNumber, bodyFatPercent: maybeNumber, sex: maybeString, goal: maybeString, trainingDaysPerWeek: maybeNumber, activityLevel: maybeString, targetCalories: maybeNumber, proteinGrams: maybeNumber, carbsGrams: maybeNumber, fatGrams: maybeNumber });
const measurement = v.object({ ...legacyStamp, source, sourceId: maybeString, recordedAt: v.number(), weightKg: maybeNumber, leanMassKg: maybeNumber, fatPercent: maybeNumber, neckCm: maybeNumber, shoulderCm: maybeNumber, chestCm: maybeNumber, leftBicepCm: maybeNumber, rightBicepCm: maybeNumber, leftForearmCm: maybeNumber, rightForearmCm: maybeNumber, abdomenCm: maybeNumber, waistCm: maybeNumber, hipsCm: maybeNumber, leftThighCm: maybeNumber, rightThighCm: maybeNumber, leftCalfCm: maybeNumber, rightCalfCm: maybeNumber });
const workout = v.object({ ...legacyStamp, source, sourceId: maybeString, title: v.string(), startedAt: v.number(), durationSeconds: v.number(), notes: maybeString, exercises: v.array(v.object({ legacyId: v.string(), title: v.string(), muscleGroups: v.array(v.string()), order: v.number(), sets: v.array(v.object({ legacyId: v.string(), setType: v.string(), reps: maybeNumber, weightKg: maybeNumber, durationSeconds: maybeNumber, distanceMeters: maybeNumber, order: v.number() })) })) });
const recipe = v.object({ ...legacyStamp, title: v.string(), source, sourceId: maybeString, sourceUrl: maybeString, imageUrl: maybeString, youtubeUrl: maybeString, category: maybeString, area: maybeString, calories: v.number(), proteinGrams: v.number(), carbsGrams: v.number(), fatGrams: v.number(), favorite: v.boolean(), notes: maybeString, ingredients: v.array(v.object({ legacyId: v.string(), name: v.string(), quantity: maybeString, order: v.number() })), instructions: v.array(v.object({ legacyId: v.string(), text: v.string(), order: v.number() })) });
const financeCategory = v.object({ legacyId: v.string(), name: v.string(), group: v.string(), excludeFromSpending: v.boolean(), color: maybeString });
const financeAccount = v.object({ ...legacyStamp, source, sourceId: maybeString, sourceVariant: maybeString, legacyImportId: maybeString, name: v.string(), institution: maybeString, mask: maybeString, type: v.string(), currency: v.string(), balance: maybeNumber, status: v.union(v.literal("active"), v.literal("hidden"), v.literal("closed")), observedAt: maybeNumber });
const financeTransaction = v.object({ ...legacyStamp, legacyAccountId: maybeString, source, sourceId: maybeString, sourceVariant: maybeString, legacyImportId: maybeString, fingerprint: v.string(), dedupeKey: maybeString, description: v.string(), amount: v.number(), currency: v.string(), postedAt: v.number(), legacyCategoryId: maybeString, status: v.string(), notes: maybeString });
const financeImport = v.object({ ...legacyStamp, source, sourceVariant: maybeString, legacyAccountId: maybeString, status: v.string(), importedCount: v.number(), skippedCount: v.number(), error: maybeString, startedAt: v.number(), finishedAt: maybeNumber });
const financeBalance = v.object({ ...legacyStamp, legacyAccountId: v.string(), currency: v.string(), cash: maybeNumber, buyingPower: maybeNumber, observedAt: v.number(), source, sourceVariant: maybeString, legacyImportId: maybeString });
const financePosition = v.object({ legacyId: v.string(), legacyAccountId: v.string(), source, sourceId: maybeString, sourceVariant: maybeString, legacyImportId: maybeString, symbol: v.string(), name: maybeString, quantity: v.number(), marketValue: maybeNumber, averageCost: maybeNumber, currency: v.string(), observedAt: maybeNumber, updatedAt: v.number() });
const financeActivity = v.object({ ...legacyStamp, legacyAccountId: maybeString, source, sourceId: maybeString, sourceVariant: maybeString, legacyImportId: maybeString, type: v.string(), description: maybeString, amount: maybeNumber, currency: v.string(), symbol: maybeString, quantity: maybeNumber, price: maybeNumber, fingerprint: v.string(), status: v.string(), occurredAt: v.number(), settledAt: maybeNumber });
const financeAccountValue = v.object({ ...legacyStamp, legacyAccountId: v.string(), source, sourceVariant: maybeString, legacyImportId: maybeString, date: v.string(), equity: v.number(), cash: maybeNumber, currency: v.string(), observedAt: v.number() });
const financeReturnRate = v.object({ ...legacyStamp, legacyAccountId: v.string(), source, sourceVariant: maybeString, legacyImportId: maybeString, timeframe: v.string(), returnPercent: v.number(), asOf: maybeString, observedAt: v.number() });
const providerConnection = v.object({ provider: v.union(v.literal("google"), v.literal("hevy"), v.literal("snaptrade")), status: v.union(v.literal("available"), v.literal("pending"), v.literal("connected"), v.literal("error"), v.literal("disabled")), scopes: v.array(v.string()), accessTokenExpiresAt: maybeNumber, credentials: v.optional(encryptedCredentials), connectedAt: maybeNumber, updatedAt: v.number() });
const wikiPage = v.object({ path: v.string(), markdown: v.string(), aliases: v.array(v.string()), tags: v.array(v.string()), createdAt: v.number(), updatedAt: v.number() });
const wikiSource = v.object({ title: v.string(), origin: v.string(), extractedText: v.string(), createdAt: v.number(), updatedAt: v.number() });

function hash(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

function titleFromPath(value: string): string {
  const name = value.split("/").at(-1)?.replace(/\.md$/i, "") ?? "Untitled";
  return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function wikiPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized === "." || normalized.split("/").includes("..")) throw new ConvexError({ code: "INVALID_PATH", message: "Wiki path is invalid" });
  return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
}

function startDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

type CanonicalSource = "manual" | "agent" | "import" | "google" | "hevy" | "snaptrade" | "csv" | "url" | "themealdb";

async function existingTask(ctx: MutationCtx, workspaceId: Id<"workspaces">, sourceValue: CanonicalSource, sourceId: string) {
  return ctx.db.query("tasks").withIndex("by_workspace_source_id", (q) => q.eq("workspaceId", workspaceId).eq("source", sourceValue).eq("sourceId", sourceId)).unique();
}

async function existingEvents(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  provider: string,
  providerEventId: string,
) {
  return ctx.db
    .query("calendarEvents")
    .withIndex("by_workspace_provider_event", (q) =>
      q
        .eq("workspaceId", workspaceId)
        .eq("provider", provider)
        .eq("providerEventId", providerEventId),
    )
    .collect();
}

async function existingMeal(ctx: MutationCtx, workspaceId: Id<"workspaces">, name: string, loggedAt: number, sourceValue: CanonicalSource) {
  return ctx.db.query("meals").withIndex("by_workspace_logged", (q) => q.eq("workspaceId", workspaceId).eq("loggedAt", loggedAt)).filter((q) => q.and(q.eq(q.field("name"), name), q.eq(q.field("source"), sourceValue))).unique();
}

async function existingMeasurement(ctx: MutationCtx, workspaceId: Id<"workspaces">, sourceValue: CanonicalSource, sourceId: string) {
  return ctx.db.query("bodyMeasurements").withIndex("by_workspace_source_id", (q) => q.eq("workspaceId", workspaceId).eq("source", sourceValue).eq("sourceId", sourceId)).unique();
}

async function existingWorkout(ctx: MutationCtx, workspaceId: Id<"workspaces">, sourceValue: CanonicalSource, sourceId: string) {
  return ctx.db.query("workouts").withIndex("by_workspace_source_id", (q) => q.eq("workspaceId", workspaceId).eq("source", sourceValue).eq("sourceId", sourceId)).unique();
}

async function existingRecipe(ctx: MutationCtx, workspaceId: Id<"workspaces">, sourceValue: CanonicalSource, sourceId: string) {
  return ctx.db.query("recipes").withIndex("by_workspace_source_id", (q) => q.eq("workspaceId", workspaceId).eq("source", sourceValue).eq("sourceId", sourceId)).unique();
}

async function existingAccount(ctx: MutationCtx, workspaceId: Id<"workspaces">, sourceValue: CanonicalSource, sourceId: string) {
  return ctx.db.query("financeAccounts").withIndex("by_workspace_source_id", (q) => q.eq("workspaceId", workspaceId).eq("source", sourceValue).eq("sourceId", sourceId)).unique();
}

async function existingTransaction(ctx: MutationCtx, workspaceId: Id<"workspaces">, sourceValue: CanonicalSource, sourceId: string) {
  return ctx.db.query("financeTransactions").withIndex("by_workspace_source_id", (q) => q.eq("workspaceId", workspaceId).eq("source", sourceValue).eq("sourceId", sourceId)).unique();
}

async function categoryId(ctx: MutationCtx, workspaceId: Id<"workspaces">, legacyId: string | undefined, byCategory: Map<string, Id<"financeCategories">>) {
  if (legacyId === undefined) return undefined;
  const mapped = byCategory.get(legacyId);
  if (mapped !== undefined) return mapped;
  const existing = await ctx.db.query("financeCategories").withIndex("by_workspace_name", (q) => q.eq("workspaceId", workspaceId).eq("normalizedName", legacyId.toLocaleLowerCase())).unique();
  return existing?._id;
}

function jobStatus(value: string): "pending" | "running" | "completed" | "failed" | "cancelled" | "cancelling" {
  if (value === "undone") return "cancelled";
  if (value === "running" || value === "completed" || value === "failed" || value === "cancelled" || value === "cancelling") return value;
  return "pending";
}

function decimal(value: number | undefined) {
  return value === undefined ? undefined : parseDecimal(String(value));
}


export const applyBatch = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    tasks: v.array(task),
    taskSessions: v.array(taskSession),
    calendarEvents: v.array(calendarEvent),
    lifeTags: v.array(lifeTag),
    meals: v.array(meal),
    macroProfiles: v.array(macroProfile),
    bodyMeasurements: v.array(measurement),
    workouts: v.array(workout),
    recipes: v.array(recipe),
    financeCategories: v.array(financeCategory),
    financeAccounts: v.array(financeAccount),
    financeTransactions: v.array(financeTransaction),
    financeImports: v.array(financeImport),
    financeBalances: v.array(financeBalance),
    financePositions: v.array(financePosition),
    financeActivities: v.array(financeActivity),
    financeAccountValueHistory: v.array(financeAccountValue),
    financeAccountReturnRates: v.array(financeReturnRate),
    providerConnections: v.array(providerConnection),
    wikiPages: v.array(wikiPage),
    wikiSources: v.array(wikiSource),
  },
  handler: async (ctx, args) => {
    const access = await requireOwner(ctx, args.workspaceId);
    const workspaceId = access.workspaceId;
    const result = { inserted: 0, updated: 0, skipped: 0 };
    const taskIds = new Map<string, Id<"tasks">>();
    const accountIds = new Map<string, Id<"financeAccounts">>();
    const categoryIds = new Map<string, Id<"financeCategories">>();
    const importIds = new Map<string, Id<"financeImportJobs">>();
    const accountImportTargets = new Map<string, string>();
    for (const row of args.financeAccounts) {
      if (row.legacyImportId !== undefined) accountImportTargets.set(row.legacyId, row.legacyImportId);
    }

    for (const row of args.tasks) {
      const sourceId = row.sourceId ?? `legacy:tasks:${row.legacyId}`;
      const existing = await existingTask(ctx, workspaceId, row.source, sourceId);
      const value = { workspaceId, title: row.title, notes: row.notes, status: row.status, priority: row.priority, dueAt: row.dueAt, source: row.source, sourceId, durationMinutes: row.durationMinutes, links: row.links, multiSession: row.multiSession, completedAt: row.completedAt, createdAt: row.createdAt, updatedAt: row.updatedAt };
      if (existing === null) { taskIds.set(row.legacyId, await ctx.db.insert("tasks", value)); result.inserted += 1; } else { taskIds.set(row.legacyId, existing._id); result.skipped += 1; }
    }
    for (const row of args.taskSessions) {
      const taskId = taskIds.get(row.taskLegacyId);
      if (taskId === undefined) { result.skipped += 1; continue; }
      const sessions = await ctx.db.query("taskSessions").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect();
      if (sessions.some((session) => session.startAt === row.startAt && session.endAt === row.endAt && session.source === row.source)) { result.skipped += 1; continue; }
      await ctx.db.insert("taskSessions", { workspaceId, taskId, startAt: row.startAt, endAt: row.endAt, status: row.status, source: row.source, createdAt: row.createdAt, updatedAt: row.updatedAt });
      result.inserted += 1;
    }
    for (const row of args.calendarEvents) {
      const sourceId = row.providerEventId ?? `legacy:calendar_events:${row.legacyId}`;
      const existing = await existingEvents(ctx, workspaceId, row.provider, sourceId);
      if (existing.length > 0) {
        for (const duplicate of existing.slice(1)) {
          await ctx.db.delete(duplicate._id);
          result.updated += 1;
        }
        result.skipped += 1;
        continue;
      }
      await ctx.db.insert("calendarEvents", { workspaceId, summary: row.summary, schedule: row.allDay ? { kind: "all_day", startDate: startDay(row.startAt), endDateExclusive: startDay(row.endAt) } : { kind: "timed", startAt: row.startAt, endAt: row.endAt, timezone: row.timezone }, startDay: startDay(row.startAt), endDay: startDay(row.endAt), location: row.location, description: row.description, tag: row.tag, source: row.source, readOnly: row.readOnly, provider: row.provider, providerEventId: sourceId, calendarId: row.calendarId, sourceHash: row.sourceHash, createdAt: row.createdAt, updatedAt: row.updatedAt });
      result.inserted += 1;
    }
    for (const row of args.lifeTags) {
      const existing = await ctx.db.query("lifeTags").withIndex("by_workspace_name", (q) => q.eq("workspaceId", workspaceId).eq("normalizedName", row.normalizedName)).unique();
      if (existing !== null) { result.skipped += 1; continue; }
      await ctx.db.insert("lifeTags", { workspaceId, name: row.name, normalizedName: row.normalizedName, color: row.color, hidden: row.hidden, systemKey: row.systemKey, createdAt: row.createdAt, updatedAt: row.updatedAt });
      result.inserted += 1;
    }
    for (const row of args.meals) {
      const sourceId = `legacy:meals:${row.legacyId}`;
      if (sourceId.length > 0 && await existingMeal(ctx, workspaceId, row.name, row.loggedAt, row.source) !== null) { result.skipped += 1; continue; }
      await ctx.db.insert("meals", { workspaceId, name: row.name, mealType: row.mealType, loggedAt: row.loggedAt, calories: row.calories, proteinGrams: row.proteinGrams, carbsGrams: row.carbsGrams, fatGrams: row.fatGrams, source: row.source, notes: row.notes, createdAt: row.createdAt, updatedAt: row.updatedAt });
      result.inserted += 1;
    }
    for (const row of args.macroProfiles) {
      const profiles = await ctx.db.query("macroProfiles").withIndex("by_workspace_active", (q) => q.eq("workspaceId", workspaceId).eq("active", row.active)).collect();
      if (profiles.some((profile) => profile.createdAt === row.createdAt)) { result.skipped += 1; continue; }
      await ctx.db.insert("macroProfiles", { workspaceId, active: row.active, birthdate: row.birthdate, heightCm: row.heightCm, weightKg: row.weightKg, bodyFatPercent: row.bodyFatPercent, sex: row.sex, goal: row.goal, trainingDaysPerWeek: row.trainingDaysPerWeek, activityLevel: row.activityLevel, targetCalories: row.targetCalories, proteinGrams: row.proteinGrams, carbsGrams: row.carbsGrams, fatGrams: row.fatGrams, createdAt: row.createdAt, updatedAt: row.updatedAt });
      result.inserted += 1;
    }
    for (const row of args.bodyMeasurements) {
      const sourceId = row.sourceId ?? `legacy:body_measurements:${row.recordedAt}`;
      if (await existingMeasurement(ctx, workspaceId, row.source, sourceId) !== null) { result.skipped += 1; continue; }
      await ctx.db.insert("bodyMeasurements", { workspaceId, source: row.source, sourceId, recordedAt: row.recordedAt, weightKg: row.weightKg, leanMassKg: row.leanMassKg, fatPercent: row.fatPercent, neckCm: row.neckCm, shoulderCm: row.shoulderCm, chestCm: row.chestCm, leftBicepCm: row.leftBicepCm, rightBicepCm: row.rightBicepCm, leftForearmCm: row.leftForearmCm, rightForearmCm: row.rightForearmCm, abdomenCm: row.abdomenCm, waistCm: row.waistCm, hipsCm: row.hipsCm, leftThighCm: row.leftThighCm, rightThighCm: row.rightThighCm, leftCalfCm: row.leftCalfCm, rightCalfCm: row.rightCalfCm, createdAt: row.createdAt, updatedAt: row.updatedAt });
      result.inserted += 1;
    }
    for (const row of args.workouts) {
      const sourceId = row.sourceId ?? `legacy:workouts:${row.legacyId}`;
      const existing = await existingWorkout(ctx, workspaceId, row.source, sourceId);
      if (existing !== null) { result.skipped += 1; continue; }
      const workoutId = await ctx.db.insert("workouts", { workspaceId, source: row.source, sourceId, title: row.title, startedAt: row.startedAt, durationSeconds: row.durationSeconds, notes: row.notes, createdAt: row.createdAt, updatedAt: row.updatedAt });
      for (const exercise of row.exercises) {
        const exerciseId = await ctx.db.insert("workoutExercises", { workspaceId, workoutId, title: exercise.title, muscleGroups: exercise.muscleGroups, order: exercise.order });
        for (const set of exercise.sets) await ctx.db.insert("exerciseSets", { workspaceId, workoutId, workoutExerciseId: exerciseId, setType: set.setType, reps: set.reps, weightKg: set.weightKg, durationSeconds: set.durationSeconds, distanceMeters: set.distanceMeters, order: set.order });
      }
      result.inserted += 1;
    }
    for (const row of args.recipes) {
      const sourceId = row.sourceId ?? `legacy:recipes:${row.legacyId}`;
      const existing = await existingRecipe(ctx, workspaceId, row.source, sourceId);
      if (existing !== null) { result.skipped += 1; continue; }
      const recipeId = await ctx.db.insert("recipes", { workspaceId, title: row.title, source: row.source, sourceId, sourceUrl: row.sourceUrl, imageUrl: row.imageUrl, youtubeUrl: row.youtubeUrl, category: row.category, area: row.area, calories: row.calories, proteinGrams: row.proteinGrams, carbsGrams: row.carbsGrams, fatGrams: row.fatGrams, favorite: row.favorite, notes: row.notes, createdAt: row.createdAt, updatedAt: row.updatedAt });
      for (const ingredient of row.ingredients) await ctx.db.insert("recipeIngredients", { workspaceId, recipeId, name: ingredient.name, quantity: ingredient.quantity, order: ingredient.order });
      for (const instruction of row.instructions) await ctx.db.insert("recipeInstructions", { workspaceId, recipeId, text: instruction.text, order: instruction.order });
      result.inserted += 1;
    }
    for (const row of args.financeCategories) {
      const normalizedName = row.name.toLocaleLowerCase();
      const existing = await ctx.db.query("financeCategories").withIndex("by_workspace_name", (q) => q.eq("workspaceId", workspaceId).eq("normalizedName", normalizedName)).unique();
      if (existing === null) categoryIds.set(row.legacyId, await ctx.db.insert("financeCategories", { workspaceId, name: row.name, normalizedName, group: row.group, excludeFromSpending: row.excludeFromSpending, color: row.color }));
      else { categoryIds.set(row.legacyId, existing._id); result.skipped += 1; continue; }
      result.inserted += 1;
    }
    for (const row of args.financeAccounts) {
      const sourceId = row.sourceId ?? `legacy:finance_accounts:${row.legacyId}`;
      const existing = await existingAccount(ctx, workspaceId, row.source, sourceId);
      if (existing !== null) { accountIds.set(row.legacyId, existing._id); result.skipped += 1; continue; }
      const id = await ctx.db.insert("financeAccounts", { workspaceId, source: row.source, sourceId, sourceVariant: row.sourceVariant, name: row.name, institution: row.institution, mask: row.mask, type: row.type, currency: row.currency, balance: decimal(row.balance), status: row.status, observedAt: row.observedAt, createdAt: row.createdAt, updatedAt: row.updatedAt });
      accountIds.set(row.legacyId, id);
      result.inserted += 1;
    }
    for (const row of args.financeImports) {
      const existing = await ctx.db.query("financeImportJobs").withIndex("by_workspace_idempotency", (q) => q.eq("workspaceId", workspaceId).eq("idempotencyKey", `legacy:finance_imports:${row.legacyId}`)).unique();
      const id = existing?._id ?? await ctx.db.insert("financeImportJobs", { workspaceId, source: row.source, sourceVariant: row.sourceVariant, accountId: row.legacyAccountId === undefined ? undefined : accountIds.get(row.legacyAccountId), status: jobStatus(row.status), idempotencyKey: `legacy:finance_imports:${row.legacyId}`, fetchedCount: row.importedCount + row.skippedCount, appliedCount: row.importedCount, skippedCount: row.skippedCount, attempt: 1, error: row.error, startedAt: row.startedAt, finishedAt: row.finishedAt, createdAt: row.createdAt, updatedAt: row.updatedAt });
      importIds.set(row.legacyId, id);
      for (const [legacyAccountId, legacyImportId] of accountImportTargets) {
        if (legacyImportId !== row.legacyId) continue;
        const accountId = accountIds.get(legacyAccountId);
        if (accountId !== undefined) await ctx.db.patch(accountId, { importJobId: id });
      }
      if (existing !== null) { result.skipped += 1; continue; }
      result.inserted += 1;
    }
    for (const row of args.financeTransactions) {
      const sourceId = row.sourceId ?? `legacy:finance_transactions:${row.legacyId}`;
      if (await existingTransaction(ctx, workspaceId, row.source, sourceId) !== null) { result.skipped += 1; continue; }
      await ctx.db.insert("financeTransactions", { workspaceId, accountId: row.legacyAccountId === undefined ? undefined : accountIds.get(row.legacyAccountId), source: row.source, sourceId, sourceVariant: row.sourceVariant, importJobId: row.legacyImportId === undefined ? undefined : importIds.get(row.legacyImportId), fingerprint: row.fingerprint, dedupeKey: row.dedupeKey, description: row.description, amount: parseDecimal(String(row.amount)), currency: row.currency, postedAt: row.postedAt, categoryId: await categoryId(ctx, workspaceId, row.legacyCategoryId, categoryIds), status: row.status, notes: row.notes, createdAt: row.createdAt, updatedAt: row.updatedAt });
      result.inserted += 1;
    }
    for (const row of args.financeBalances) {
      const accountId = accountIds.get(row.legacyAccountId);
      if (accountId === undefined) { result.skipped += 1; continue; }
      const existing = await ctx.db.query("financeBalances").withIndex("by_account_currency", (q) => q.eq("accountId", accountId).eq("currency", row.currency)).unique();
      if (existing !== null) { result.skipped += 1; continue; }
      await ctx.db.insert("financeBalances", { workspaceId, accountId, currency: row.currency, cash: decimal(row.cash), buyingPower: decimal(row.buyingPower), observedAt: row.observedAt, source: row.source, sourceVariant: row.sourceVariant, importJobId: row.legacyImportId === undefined ? undefined : importIds.get(row.legacyImportId), createdAt: row.createdAt, updatedAt: row.updatedAt });
      result.inserted += 1;
    }
    for (const row of args.financePositions) {
      const accountId = accountIds.get(row.legacyAccountId);
      if (accountId === undefined) { result.skipped += 1; continue; }
      const sourceId = row.sourceId ?? `legacy:finance_positions:${row.legacyId}`;
      const existing = await ctx.db.query("financePositions").withIndex("by_account_source_id", (q) => q.eq("accountId", accountId).eq("source", row.source).eq("sourceId", sourceId)).unique();
      if (existing !== null) { result.skipped += 1; continue; }
      await ctx.db.insert("financePositions", { workspaceId, accountId, source: row.source, sourceId, sourceVariant: row.sourceVariant, importJobId: row.legacyImportId === undefined ? undefined : importIds.get(row.legacyImportId), symbol: row.symbol, name: row.name, quantity: parseDecimal(String(row.quantity)), marketValue: decimal(row.marketValue), averageCost: decimal(row.averageCost), currency: row.currency, observedAt: row.observedAt, updatedAt: row.updatedAt });
      result.inserted += 1;
    }
    for (const row of args.financeActivities) {
      const existing = await ctx.db.query("financeActivities").withIndex("by_workspace_source_fingerprint", (q) => q.eq("workspaceId", workspaceId).eq("source", row.source).eq("fingerprint", row.fingerprint)).unique();
      if (existing !== null) { result.skipped += 1; continue; }
      await ctx.db.insert("financeActivities", { workspaceId, accountId: row.legacyAccountId === undefined ? undefined : accountIds.get(row.legacyAccountId), source: row.source, sourceId: row.sourceId, sourceVariant: row.sourceVariant, importJobId: row.legacyImportId === undefined ? undefined : importIds.get(row.legacyImportId), type: row.type, description: row.description, amount: decimal(row.amount), currency: row.currency, symbol: row.symbol, quantity: decimal(row.quantity), price: decimal(row.price), fingerprint: row.fingerprint, status: row.status, occurredAt: row.occurredAt, settledAt: row.settledAt, createdAt: row.createdAt, updatedAt: row.updatedAt });
      result.inserted += 1;
    }
    for (const row of args.financeAccountValueHistory) {
      const accountId = accountIds.get(row.legacyAccountId);
      if (accountId === undefined) { result.skipped += 1; continue; }
      const existing = await ctx.db.query("financeAccountValueHistory").withIndex("by_account_date", (q) => q.eq("accountId", accountId).eq("date", row.date)).filter((q) => q.eq(q.field("source"), row.source)).unique();
      if (existing !== null) { result.skipped += 1; continue; }
      await ctx.db.insert("financeAccountValueHistory", { workspaceId, accountId, source: row.source, sourceVariant: row.sourceVariant, importJobId: row.legacyImportId === undefined ? undefined : importIds.get(row.legacyImportId), date: row.date, equity: parseDecimal(String(row.equity)), cash: decimal(row.cash), currency: row.currency, observedAt: row.observedAt, createdAt: row.createdAt, updatedAt: row.updatedAt });
      result.inserted += 1;
    }
    for (const row of args.financeAccountReturnRates) {
      const accountId = accountIds.get(row.legacyAccountId);
      if (accountId === undefined) { result.skipped += 1; continue; }
      const existing = await ctx.db.query("financeAccountReturnRates").withIndex("by_account_timeframe", (q) => q.eq("accountId", accountId).eq("timeframe", row.timeframe)).filter((q) => q.eq(q.field("source"), row.source)).unique();
      if (existing !== null) { result.skipped += 1; continue; }
      await ctx.db.insert("financeAccountReturnRates", { workspaceId, accountId, source: row.source, sourceVariant: row.sourceVariant, importJobId: row.legacyImportId === undefined ? undefined : importIds.get(row.legacyImportId), timeframe: row.timeframe, returnPercent: row.returnPercent, asOf: row.asOf, observedAt: row.observedAt, createdAt: row.createdAt, updatedAt: row.updatedAt });
      result.inserted += 1;
    }
    for (const row of args.providerConnections) {
      const existing = await ctx.db.query("providerConnections").withIndex("by_workspace_provider", (q) => q.eq("workspaceId", workspaceId).eq("provider", row.provider)).unique();
      const value = row.provider === "google" ? { workspaceId, provider: row.provider, status: row.status, scopes: row.scopes, accessTokenExpiresAt: row.accessTokenExpiresAt, credentials: row.credentials, connectedAt: row.connectedAt, updatedAt: row.updatedAt } : { workspaceId, provider: row.provider, status: row.status, credentials: row.credentials, connectedAt: row.connectedAt, updatedAt: row.updatedAt };
      if (existing !== null) {
        if (existing.updatedAt >= row.updatedAt) {
          result.skipped += 1;
          continue;
        }
        await ctx.db.patch(existing._id, value);
        result.updated += 1;
        continue;
      }
      await ctx.db.insert("providerConnections", value);
      result.inserted += 1;
    }
    for (const row of args.wikiPages) {
      const normalizedPath = wikiPath(row.path);
      const contentHash = hash(row.markdown);
      const existing = await ctx.db.query("wikiPages").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", normalizedPath)).unique();
      if (existing !== null) {
        if (existing.currentRevisionId !== undefined) {
          const revision = await ctx.db.get(existing.currentRevisionId);
          if (revision?.contentHash === contentHash) { result.skipped += 1; continue; }
        }
        result.skipped += 1;
        continue;
      }
      const pageId = await ctx.db.insert("wikiPages", { workspaceId, path: normalizedPath, title: titleFromPath(normalizedPath), aliases: row.aliases.map(wikiPath), tags: row.tags, revisionNumber: 0, status: "active", createdAt: row.createdAt, updatedAt: row.updatedAt });
      const revisionId = await ctx.db.insert("wikiRevisions", { workspaceId, pageId, revisionNumber: 1, markdown: row.markdown, contentHash, authorKind: "import", summary: "Imported from legacy filesystem Wiki", createdAt: row.updatedAt });
      await ctx.db.patch(pageId, { currentRevisionId: revisionId, revisionNumber: 1 });
      await ctx.db.insert("wikiSearchDocuments", { workspaceId, pageId, currentRevisionId: revisionId, path: normalizedPath, title: titleFromPath(normalizedPath), aliases: row.aliases.map(wikiPath), tags: row.tags, markdown: row.markdown, searchText: `${normalizedPath}\n${row.tags.join(" ")}\n${row.aliases.join(" ")}\n${row.markdown}`, contentHash, status: "active", updatedAt: row.updatedAt });
      await ctx.scheduler.runAfter(0, internal.capability.wiki.indexRevision, { pageId, revisionId });
      for (const alias of row.aliases.map(wikiPath)) await ctx.db.insert("wikiPageAliases", { workspaceId, path: alias, pageId, createdAt: row.createdAt });
      result.inserted += 1;
    }
    for (const row of args.wikiSources) {
      const contentHash = hash(row.extractedText);
      const existing = await ctx.db.query("wikiSources").withIndex("by_workspace_hash", (q) => q.eq("workspaceId", workspaceId).eq("contentHash", contentHash)).unique();
      if (existing !== null) { result.skipped += 1; continue; }
      const sourceId = await ctx.db.insert("wikiSources", { workspaceId, kind: "directory_import", title: row.title, origin: row.origin, extractedText: row.extractedText, contentHash, status: "indexed", createdAt: row.createdAt, updatedAt: row.updatedAt });
      await ctx.scheduler.runAfter(0, internal.capability.wiki.indexSource, { sourceId });
      result.inserted += 1;
    }
    return result;
  },
});
