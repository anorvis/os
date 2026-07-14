import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { api } from "../../convex/_generated/api";

type Source = "manual" | "agent" | "import" | "google" | "hevy" | "snaptrade" | "csv" | "url" | "themealdb";
type Payload = {
  tasks: Array<Record<string, unknown>>;
  taskSessions: Array<Record<string, unknown>>;
  calendarEvents: Array<Record<string, unknown>>;
  lifeTags: Array<Record<string, unknown>>;
  meals: Array<Record<string, unknown>>;
  macroProfiles: Array<Record<string, unknown>>;
  bodyMeasurements: Array<Record<string, unknown>>;
  workouts: Array<Record<string, unknown>>;
  recipes: Array<Record<string, unknown>>;
  financeCategories: Array<Record<string, unknown>>;
  financeAccounts: Array<Record<string, unknown>>;
  financeTransactions: Array<Record<string, unknown>>;
  financeImports: Array<Record<string, unknown>>;
  financeBalances: Array<Record<string, unknown>>;
  financePositions: Array<Record<string, unknown>>;
  financeActivities: Array<Record<string, unknown>>;
  financeAccountValueHistory: Array<Record<string, unknown>>;
  financeAccountReturnRates: Array<Record<string, unknown>>;
  providerConnections: Array<Record<string, unknown>>;
  wikiPages: Array<Record<string, unknown>>;
  wikiSources: Array<Record<string, unknown>>;
};
type ImportResult = { inserted: number; updated: number; skipped: number };
type AdminConvexClient = ConvexHttpClient & {
  setAdminAuth: (
    adminKey: string,
    identity: { subject: string; issuer: string; tokenIdentifier: string },
  ) => void;
};


type Row = Record<string, string | number | null>;
type SecretRefs = Record<string, string>;

const supportedTables = new Set([
  "schema_migrations",
  "calendar_events",
  "tasks",
  "task_sessions",
  "meals",
  "workouts",
  "workout_exercises",
  "exercise_sets",
  "macro_profiles",
  "finance_accounts",
  "finance_transactions",
  "finance_categories",
  "secret_records",
  "provider_connections",
  "recipes",
  "recipe_ingredients",
  "recipe_instructions",
  "life_tags",
  "body_measurements",
  "health_meals",
  "health_macro_profiles",
  "health_workouts",
  "health_workout_exercises",
  "health_workout_sets",
  "finance_imports",
  "finance_balances",
  "finance_positions",
  "finance_activities",
  "finance_account_value_history",
  "finance_account_return_rates",
]);

const payloadKeys: Array<keyof Payload> = [
  "tasks",
  "taskSessions",
  "calendarEvents",
  "lifeTags",
  "meals",
  "macroProfiles",
  "bodyMeasurements",
  "workouts",
  "recipes",
  "financeCategories",
  "financeAccounts",
  "financeImports",
  "financeTransactions",
  "financeBalances",
  "financePositions",
  "financeActivities",
  "financeAccountValueHistory",
  "financeAccountReturnRates",
  "providerConnections",
  "wikiPages",
  "wikiSources",
];

const sources = new Set<Source>(["manual", "agent", "import", "google", "hevy", "snaptrade", "csv", "url", "themealdb"]);

function arg(name: string): string | undefined {
  const prefix = `${name}=`;
  return Bun.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function flag(name: string): boolean {
  return Bun.argv.includes(name);
}

function text(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const result = String(value).trim();
  return result.length === 0 ? undefined : result;
}

function num(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function bool(value: string | number | null | undefined): boolean {
  return value === 1 || value === "1" || value === "true";
}

function stamp(row: Row): { legacyId: string; createdAt: number; updatedAt: number } {
  const legacyId = String(row.id ?? crypto.randomUUID());
  return { legacyId, createdAt: millis(row.created_at) ?? Date.now(), updatedAt: millis(row.updated_at) ?? millis(row.created_at) ?? Date.now() };
}

function millis(value: string | number | null | undefined): number | undefined {
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
  const content = text(value);
  if (content === undefined) return undefined;
  const parsed = Date.parse(content);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function taskPriority(
  value: string | number | null | undefined,
): "low" | "medium" | "high" | "urgent" | undefined {
  const candidate = text(value);
  if (candidate === "low" || candidate === "high" || candidate === "urgent") {
    return candidate;
  }
  return candidate === undefined ? undefined : "medium";
}

function accountStatus(value: string | number | null | undefined): "active" | "hidden" | "closed" {
  const candidate = text(value);
  if (candidate === "hidden" || candidate === "closed") return candidate;
  return "active";
}

function source(value: string | number | null | undefined): Source {
  const candidate = text(value) ?? "import";
  if (sources.has(candidate as Source)) return candidate as Source;
  if (candidate.startsWith("csv:")) return "csv";
  return "import";
}

function jsonArray(value: string | number | null | undefined): string[] {
  const content = text(value);
  if (content === undefined) return [];
  const decoded: unknown = JSON.parse(content);
  return Array.isArray(decoded) ? decoded.filter((item) => typeof item === "string") : [];
}

function jsonObject(value: string | number | null | undefined): Record<string, unknown> {
  const content = text(value);
  if (content === undefined) return {};
  const decoded: unknown = JSON.parse(content);
  return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded) ? decoded as Record<string, unknown> : {};
}

function jsonRecord(value: string | number | null | undefined): SecretRefs {
  const content = text(value);
  if (content === undefined) return {};
  const decoded: unknown = JSON.parse(content);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return {};
  const entries: SecretRefs = {};
  for (const [key, item] of Object.entries(decoded)) if (typeof item === "string") entries[key] = item;
  return entries;
}

function rows(db: Database, table: string): Row[] {
  const exists = db.query<Row, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table);
  return exists === null ? [] : db.query<Row, []>(`SELECT * FROM ${table}`).all();
}

function localSecret(ref: string, db: Database): string | undefined {
  if (ref.startsWith("keychain:")) {
    const id = ref.slice("keychain:".length);
    const result = Bun.spawnSync(["security", "find-generic-password", "-a", id, "-s", "anorvis-os", "-w"], { stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trimEnd() : undefined;
  }
  if (!ref.startsWith("secret:")) return undefined;
  const id = ref.slice("secret:".length);
  const record = db.query<Row, [string]>("SELECT nonce, ciphertext FROM secret_records WHERE id = ?1 AND provider = 'local'").get(id);
  if (record === null) return undefined;
  const keyPath = process.env.ANORVIS_SECRET_KEY_PATH ?? join(homedir(), ".anorvis", "os", "secret-key");
  const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
  const payload = Buffer.from(String(record.ciphertext), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(String(record.nonce), "base64"));
  decipher.setAuthTag(payload.subarray(payload.length - 16));
  return Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]).toString("utf8");
}

function encryptCredentials(credentials: Record<string, string>): Record<string, unknown> | undefined {
  if (Object.keys(credentials).length === 0) return undefined;
  const encoded = process.env.ANORVIS_CREDENTIAL_KEY;
  if (!encoded && flag("--dry-run")) return { algorithm: "aes-256-gcm", keyVersion: 1, nonce: "<dry-run>", ciphertext: "<dry-run>" };
  if (!encoded) throw new Error("ANORVIS_CREDENTIAL_KEY is required to migrate provider credentials.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("ANORVIS_CREDENTIAL_KEY must be a base64-encoded 32-byte key.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return { algorithm: "aes-256-gcm", keyVersion: 1, nonce: nonce.toString("base64"), ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64") };
}

function wikiFiles(root: string): Pick<Payload, "wikiPages" | "wikiSources"> {
  const wikiPages: Payload["wikiPages"] = [];
  const wikiSources: Payload["wikiSources"] = [];
  if (!existsSync(root)) return { wikiPages, wikiSources };
  const canonicalRoot = join(root, "wiki");
  const excludedPageNames = new Set(["log.md", "cache.md", "index.md", "vault.md", "descriptor.md"]);
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (name.toLowerCase().endsWith(".md")) {
        const markdown = readFileSync(path, "utf8");
        const relativePath = relative(root, path);
        const isCanonicalPage = path.startsWith(`${canonicalRoot}/`) && !excludedPageNames.has(name.toLowerCase()) && !relativePath.includes("/generated/");
        if (isCanonicalPage) {
          const aliases = [...markdown.matchAll(/^aliases:\s*\[(.*)\]\s*$/gm)].flatMap((match) => match[1].split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean));
          const tags = [...new Set([...markdown.matchAll(/(?:^|\s)#([\w/-]+)/g)].map((match) => match[1]))];
          wikiPages.push({ path: relative(canonicalRoot, path), markdown, aliases, tags, createdAt: stat.birthtimeMs, updatedAt: stat.mtimeMs });
        } else if (relativePath.startsWith("raw/notes/") || relativePath.startsWith("raw/sessions/")) {
          wikiSources.push({ title: name.replace(/\.md$/i, ""), origin: relativePath, extractedText: markdown, createdAt: stat.birthtimeMs, updatedAt: stat.mtimeMs });
        }
      }
    }
  };
  visit(root);
  return { wikiPages, wikiSources };
}
function fileCount(root: string): number {
  if (!existsSync(root)) return 0;
  let count = 0;
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else count += 1;
    }
  };
  visit(root);
  return count;
}


function buildPayload(db: Database, wikiRoot: string): Payload {
  const payload: Payload = Object.fromEntries(payloadKeys.map((key) => [key, []])) as unknown as Payload;
  for (const row of rows(db, "tasks")) payload.tasks.push({ ...stamp(row), title: text(row.title) ?? "Untitled", notes: text(row.notes), status: text(row.status) ?? "open", priority: taskPriority(row.priority), dueAt: millis(row.due_at), source: source(row.source), sourceId: text(row.source_id), durationMinutes: num(row.duration_minutes), links: jsonArray(row.links_json), multiSession: bool(row.multi_session), completedAt: millis(row.completed_at) });
  for (const row of rows(db, "task_sessions")) payload.taskSessions.push({ ...stamp(row), taskLegacyId: String(row.task_id), startAt: millis(row.start_at) ?? Date.now(), endAt: millis(row.end_at) ?? Date.now(), status: text(row.status) ?? "planned", source: source(row.source) });
  for (const row of rows(db, "calendar_events")) payload.calendarEvents.push({ ...stamp(row), summary: text(row.summary) ?? "Untitled", startAt: millis(row.start_at) ?? Date.now(), endAt: millis(row.end_at) ?? Date.now(), location: text(row.location), description: text(row.description), tag: text(row.tag), source: source(row.source), readOnly: bool(row.read_only), provider: text(row.provider) ?? "local", providerEventId: text(row.provider_event_id), calendarId: text(row.calendar_id), allDay: bool(row.all_day), timezone: text(row.timezone), sourceHash: text(row.source_hash) });
  for (const row of rows(db, "life_tags")) payload.lifeTags.push({ ...stamp(row), name: text(row.name) ?? "Untitled", normalizedName: text(row.normalized_name) ?? (text(row.name) ?? "untitled").toLocaleLowerCase(), color: text(row.color), hidden: bool(row.hidden), systemKey: text(row.system_key) });
  for (const row of rows(db, "meals")) payload.meals.push({ ...stamp(row), name: text(row.name) ?? "Meal", mealType: text(row.meal_type) ?? "meal", loggedAt: millis(row.logged_at) ?? Date.now(), calories: num(row.calories) ?? 0, proteinGrams: num(row.protein_grams) ?? 0, carbsGrams: num(row.carbs_grams) ?? 0, fatGrams: num(row.fat_grams) ?? 0, source: source(row.source), notes: text(row.notes) });
  for (const row of rows(db, "macro_profiles")) payload.macroProfiles.push({ ...stamp(row), active: bool(row.active), birthdate: text(row.birthdate), heightCm: num(row.height_cm), weightKg: num(row.weight_kg), bodyFatPercent: num(row.body_fat_percent), sex: text(row.sex), goal: text(row.goal), trainingDaysPerWeek: num(row.training_days_per_week), activityLevel: text(row.activity_level), targetCalories: num(row.target_calories), proteinGrams: num(row.protein_grams), carbsGrams: num(row.carbs_grams), fatGrams: num(row.fat_grams) });
  for (const row of rows(db, "body_measurements")) payload.bodyMeasurements.push({ ...stamp(row), source: source(row.source), sourceId: text(row.source_id), recordedAt: millis(row.recorded_at) ?? Date.now(), weightKg: num(row.weight_kg), leanMassKg: num(row.lean_mass_kg), fatPercent: num(row.fat_percent), neckCm: num(row.neck_cm), shoulderCm: num(row.shoulder_cm), chestCm: num(row.chest_cm), leftBicepCm: num(row.left_bicep_cm), rightBicepCm: num(row.right_bicep_cm), leftForearmCm: num(row.left_forearm_cm), rightForearmCm: num(row.right_forearm_cm), abdomenCm: num(row.abdomen_cm), waistCm: num(row.waist_cm), hipsCm: num(row.hips_cm), leftThighCm: num(row.left_thigh_cm), rightThighCm: num(row.right_thigh_cm), leftCalfCm: num(row.left_calf_cm), rightCalfCm: num(row.right_calf_cm) });
  const exercises = rows(db, "workout_exercises");
  const sets = rows(db, "exercise_sets");
  const canonicalWorkoutRows = rows(db, "workouts");
  const canonicalHevyWorkoutIds = new Set(canonicalWorkoutRows.map((row) => String(row.id)).filter((id) => id.startsWith("hevy:")).map((id) => id.slice("hevy:".length)));
  for (const row of canonicalWorkoutRows) payload.workouts.push({ ...stamp(row), source: source(row.source), sourceId: text(row.source_id) ?? (String(row.id).startsWith("hevy:") ? String(row.id).slice("hevy:".length) : undefined), title: text(row.title) ?? "Workout", startedAt: millis(row.started_at) ?? Date.now(), durationSeconds: num(row.duration_seconds) ?? 0, notes: text(row.notes), exercises: exercises.filter((exercise) => exercise.workout_id === row.id).map((exercise) => ({ legacyId: String(exercise.id), title: text(exercise.title) ?? "Exercise", muscleGroups: jsonArray(exercise.muscle_groups_json), order: num(exercise.order_index) ?? 0, sets: sets.filter((set) => set.workout_exercise_id === exercise.id).map((set) => ({ legacyId: String(set.id), setType: text(set.set_type) ?? "normal", reps: num(set.reps), weightKg: num(set.weight_kg), durationSeconds: num(set.duration_seconds), distanceMeters: num(set.distance_meters), order: num(set.order_index) ?? 0 })) })) });
  for (const row of rows(db, "health_meals")) payload.meals.push({ ...stamp(row), name: text(row.name) ?? "Meal", mealType: text(row.meal_type) ?? "meal", loggedAt: millis(row.logged_at) ?? Date.now(), calories: num(row.calories) ?? 0, proteinGrams: num(row.protein_grams) ?? 0, carbsGrams: num(row.carbs_grams) ?? 0, fatGrams: num(row.fat_grams) ?? 0, source: source(row.source), notes: text(row.notes) });
  const healthMacroRows = rows(db, "health_macro_profiles");
  const newestHealthMacroUpdatedAt = Math.max(0, ...healthMacroRows.map((row) => millis(row.updated_at) ?? 0));
  for (const row of healthMacroRows) payload.macroProfiles.push({ ...stamp(row), active: (millis(row.updated_at) ?? 0) === newestHealthMacroUpdatedAt, birthdate: text(row.birthdate), heightCm: num(row.height_cm), weightKg: num(row.weight_kg), bodyFatPercent: num(row.body_fat_percent), sex: text(row.sex), goal: text(row.goal), trainingDaysPerWeek: num(row.training_days_per_week), activityLevel: text(row.activity_level), targetCalories: num(row.target_calories), proteinGrams: num(row.protein_grams), carbsGrams: num(row.carbs_grams), fatGrams: num(row.fat_grams) });
  const healthExercises = rows(db, "health_workout_exercises");
  const healthSets = rows(db, "health_workout_sets");
  for (const row of rows(db, "health_workouts")) {
    const hevyId = text(row.notes)?.startsWith("hevy:") ? text(row.notes)?.slice("hevy:".length) : undefined;
    if (hevyId !== undefined && canonicalHevyWorkoutIds.has(hevyId)) continue;
    payload.workouts.push({ ...stamp(row), source: source(row.source), sourceId: hevyId ?? `legacy:health_workouts:${String(row.id)}`, title: text(row.title) ?? "Workout", startedAt: millis(row.started_at) ?? Date.now(), durationSeconds: num(row.duration_seconds) ?? 0, notes: text(row.notes), exercises: healthExercises.filter((exercise) => exercise.workout_id === row.id).map((exercise) => ({ legacyId: String(exercise.id), title: text(exercise.title) ?? "Exercise", muscleGroups: [], order: num(exercise.position) ?? 0, sets: healthSets.filter((set) => set.exercise_id === exercise.id).map((set) => ({ legacyId: String(set.id), setType: text(set.set_type) ?? "normal", reps: num(set.reps), weightKg: num(set.weight_kg), order: num(set.position) ?? 0 })) })) });
  }
  const ingredients = rows(db, "recipe_ingredients");
  const instructions = rows(db, "recipe_instructions");
  for (const row of rows(db, "recipes")) payload.recipes.push({ ...stamp(row), title: text(row.title) ?? "Recipe", source: source(row.source), sourceId: text(row.source_id), sourceUrl: text(row.source_url), imageUrl: text(row.image_url), youtubeUrl: text(row.youtube_url), category: text(row.category), area: text(row.area), calories: num(row.calories) ?? 0, proteinGrams: num(row.protein_grams) ?? 0, carbsGrams: num(row.carbs_grams) ?? 0, fatGrams: num(row.fat_grams) ?? 0, favorite: bool(row.is_favorite), notes: text(row.notes), ingredients: ingredients.filter((item) => item.recipe_id === row.id).map((item) => ({ legacyId: String(item.id), name: text(item.name) ?? "Ingredient", quantity: text(item.quantity), order: num(item.order_index) ?? 0 })), instructions: instructions.filter((item) => item.recipe_id === row.id).map((item) => ({ legacyId: String(item.id), text: text(item.text) ?? "", order: num(item.step_index) ?? 0 })) });
  for (const row of rows(db, "finance_categories")) payload.financeCategories.push({ legacyId: String(row.id), name: text(row.name) ?? String(row.id), group: text(row.group_name) ?? "other", excludeFromSpending: bool(row.exclude_from_spending), color: text(row.color) });
  for (const row of rows(db, "finance_accounts")) payload.financeAccounts.push({ ...stamp(row), source: source(row.source), sourceId: text(row.source_id), sourceVariant: text(row.source_variant), legacyImportId: text(row.import_id), name: text(row.name) ?? "Account", institution: text(row.institution), mask: text(row.mask), type: text(row.type) ?? "other", currency: text(row.currency) ?? "USD", balance: num(row.balance), status: accountStatus(row.status), observedAt: millis(row.observed_at) });
  for (const row of rows(db, "finance_transactions")) payload.financeTransactions.push({ ...stamp(row), legacyAccountId: text(row.account_id), source: source(row.source), sourceId: text(row.source_id), sourceVariant: text(row.source_variant), legacyImportId: text(row.import_id), fingerprint: text(row.fingerprint) ?? String(row.id), dedupeKey: text(row.dedupe_key), description: text(row.description) ?? "Transaction", amount: num(row.amount) ?? 0, currency: text(row.currency) ?? "USD", postedAt: millis(row.posted_at) ?? Date.now(), legacyCategoryId: text(row.category_id), status: text(row.status) ?? "posted", notes: text(row.notes) });
  for (const row of rows(db, "finance_imports")) payload.financeImports.push({ ...stamp(row), source: source(row.source), sourceVariant: text(row.source_variant), legacyAccountId: text(row.account_id), status: text(row.status) ?? "pending", importedCount: num(row.imported_count) ?? 0, skippedCount: num(row.skipped_count) ?? 0, error: text(row.error), startedAt: millis(row.started_at) ?? Date.now(), finishedAt: millis(row.finished_at) });
  for (const row of rows(db, "finance_balances")) payload.financeBalances.push({ ...stamp(row), legacyAccountId: String(row.account_id), currency: text(row.currency) ?? "USD", cash: num(row.cash), buyingPower: num(row.buying_power), observedAt: millis(row.observed_at) ?? Date.now(), source: source(row.source), sourceVariant: text(row.source_variant), legacyImportId: text(row.import_id) });
  for (const row of rows(db, "finance_positions")) payload.financePositions.push({ legacyId: String(row.id), legacyAccountId: String(row.account_id), source: source(row.source), sourceId: text(row.source_id), sourceVariant: text(row.source_variant), legacyImportId: text(row.import_id), symbol: text(row.symbol) ?? "UNKNOWN", name: text(row.name), quantity: num(row.quantity) ?? 0, marketValue: num(row.market_value), averageCost: num(row.average_cost), currency: text(row.currency) ?? "USD", observedAt: millis(row.observed_at), updatedAt: millis(row.updated_at) ?? Date.now() });
  for (const row of rows(db, "finance_activities")) payload.financeActivities.push({ ...stamp(row), legacyAccountId: text(row.account_id), source: source(row.source), sourceId: text(row.source_id), sourceVariant: text(row.source_variant), legacyImportId: text(row.import_id), type: text(row.type) ?? "unknown", description: text(row.description), amount: num(row.amount), currency: text(row.currency) ?? "USD", symbol: text(row.symbol), quantity: num(row.quantity), price: num(row.price), fingerprint: text(row.fingerprint) ?? String(row.id), status: text(row.status) ?? "posted", occurredAt: millis(row.occurred_at) ?? Date.now(), settledAt: millis(row.settled_at) });
  for (const row of rows(db, "finance_account_value_history")) payload.financeAccountValueHistory.push({ ...stamp(row), legacyAccountId: String(row.account_id), source: source(row.source), sourceVariant: text(row.source_variant), legacyImportId: text(row.import_id), date: text(row.date) ?? new Date(millis(row.observed_at) ?? Date.now()).toISOString().slice(0, 10), equity: num(row.equity) ?? 0, cash: num(row.cash), currency: text(row.currency) ?? "USD", observedAt: millis(row.observed_at) ?? Date.now() });
  for (const row of rows(db, "finance_account_return_rates")) payload.financeAccountReturnRates.push({ ...stamp(row), legacyAccountId: String(row.account_id), source: source(row.source), sourceVariant: text(row.source_variant), legacyImportId: text(row.import_id), timeframe: text(row.timeframe) ?? "unknown", returnPercent: num(row.return_percent) ?? 0, asOf: text(row.as_of), observedAt: millis(row.observed_at) ?? Date.now() });
  for (const row of rows(db, "provider_connections")) {
    const provider = text(row.provider_id);
    if (provider !== "google" && provider !== "hevy" && provider !== "snaptrade") continue;
    const refs = jsonRecord(row.secret_refs_json);
    const credentials: Record<string, string> = {};
    if (!flag("--dry-run")) {
      for (const [name, ref] of Object.entries(refs)) {
        const value = localSecret(ref, db);
        if (value !== undefined) credentials[name] = value;
      }
    }
    if (provider === "hevy" && credentials.apiKey === undefined) {
      const token = credentials.token;
      if (token !== undefined) credentials.apiKey = token;
      delete credentials.token;
    }
    const settings = jsonObject(row.settings_json);
    const scopesValue = settings.scopes;
    const scopes = Array.isArray(scopesValue) ? scopesValue.filter((item) => typeof item === "string") : typeof scopesValue === "string" ? scopesValue.split(/\s+/).filter(Boolean) : [];
    const expiry = typeof settings.accessTokenExpiresAt === "number" || typeof settings.accessTokenExpiresAt === "string" ? millis(settings.accessTokenExpiresAt) : undefined;
    const updatedAt = (millis(row.updated_at) ?? Date.now()) + (provider === "hevy" ? 1 : 0);
    payload.providerConnections.push({ provider, status: text(row.status) ?? "available", scopes, accessTokenExpiresAt: expiry, credentials: encryptCredentials(credentials), connectedAt: millis(row.connected_at), updatedAt });
  }
  const wiki = wikiFiles(wikiRoot);
  payload.wikiPages = wiki.wikiPages;
  payload.wikiSources = wiki.wikiSources;
  return payload;
}

function emptyBatch(): Payload {
  return Object.fromEntries(payloadKeys.map((name) => [name, []])) as unknown as Payload;
}

function batches(payload: Payload, size: number): Payload[] {
  const output: Payload[] = [];
  const financeContext = {
    financeCategories: payload.financeCategories,
    financeAccounts: payload.financeAccounts,
    financeImports: payload.financeImports,
  };
  for (const key of payloadKeys) {
    for (let index = 0; index < payload[key].length; index += size) {
      const batch = emptyBatch();
      batch[key] = payload[key].slice(index, index + size);
      if (key === "taskSessions") batch.tasks = payload.tasks;
      if (key.startsWith("finance") && key !== "financeCategories" && key !== "financeAccounts" && key !== "financeImports") Object.assign(batch, financeContext);
      if (key === "financeImports") batch.financeAccounts = payload.financeAccounts;
      output.push(batch);
    }
  }
  return output.length === 0 ? [emptyBatch()] : output;
}

async function importRemote(payload: Payload, size: number): Promise<ImportResult[]> {
  const url = process.env.ANORVIS_CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "http://127.0.0.1:3210";
  const token = process.env.ANORVIS_CONVEX_AUTH_TOKEN;
  if (!token) throw new Error("ANORVIS_CONVEX_AUTH_TOKEN is required for remote import. For local admin import, pass --identity-subject=<owner-user-id>.");
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  // The generated API type is refreshed by Convex codegen in normal dev flow; this new module is present at runtime now.
  const legacyApply = api.legacyImport.applyBatch as unknown as FunctionReference<"mutation", "public", Payload, ImportResult>;
  const results: ImportResult[] = [];
  for (const batch of batches(payload, size)) results.push(await client.mutation(legacyApply, batch));
  return results;
}

async function importLocal(payload: Payload, size: number, subject: string): Promise<ImportResult[]> {
  const configPath = arg("--convex-config") ?? join(".convex", "local", "default", "config.json");
  const decoded: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid local Convex config.");
  const ports = "ports" in decoded ? decoded.ports : undefined;
  if (ports === null || typeof ports !== "object" || Array.isArray(ports) || !("cloud" in ports) || typeof ports.cloud !== "number") throw new Error("Local Convex config does not include ports.cloud.");
  const adminKey = "adminKey" in decoded && typeof decoded.adminKey === "string" ? decoded.adminKey : undefined;
  if (adminKey === undefined) throw new Error("Local Convex config does not include adminKey.");
  const client = new ConvexHttpClient(`http://127.0.0.1:${ports.cloud}`);
  const adminClient = client as unknown as AdminConvexClient;
  adminClient.setAdminAuth(adminKey, {
    subject,
    issuer: "https://convex.test",
    tokenIdentifier: `https://convex.test|${subject}`,
  });
  const legacyApply = api.legacyImport.applyBatch as unknown as FunctionReference<"mutation", "public", Payload, ImportResult>;
  const results: ImportResult[] = [];
  for (const batch of batches(payload, size)) results.push(await client.mutation(legacyApply, batch));
  return results;
}

function summarize(results: ImportResult[]): ImportResult {
  return results.reduce((total, item) => ({ inserted: total.inserted + item.inserted, updated: total.updated + item.updated, skipped: total.skipped + item.skipped }), { inserted: 0, updated: 0, skipped: 0 });
}

function report(payload: Payload, unsupported: Array<{ table: string; count: number }>): void {
  const counts = Object.fromEntries(payloadKeys.map((key) => [key, payload[key].length]));
  const identitySubject = arg("--identity-subject") ?? "<owner-user-id>";
  console.log(JSON.stringify({ counts, unsupported, importCommand: `bun src/tools/migrate-legacy.ts --identity-subject=${identitySubject} --allow-unsupported` }, null, 2));
}

const dbPath = arg("--db") ?? process.env.ANORVIS_DB_PATH ?? join(homedir(), ".anorvis", "db", "anorvis.sqlite");
const wikiRoot = arg("--wiki") ?? join(homedir(), ".anorvis", "llm-wiki");
const monitorRoot = arg("--monitor") ?? join(homedir(), ".anorvis", "monitor");
if (!existsSync(dbPath)) throw new Error(`Legacy database not found: ${dbPath}`);
const db = new Database(dbPath, { readonly: true });
const unsupported = db.query<Row, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)).filter((table) => !supportedTables.has(table)).map((table) => ({ table, count: db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0 })).filter((row) => row.count > 0);
const monitorFileCount = fileCount(monitorRoot);
if (monitorFileCount > 0) unsupported.push({ table: `filesystem:${monitorRoot}`, count: monitorFileCount });
const payload = buildPayload(db, wikiRoot);
if (flag("--dry-run")) {
  report(payload, unsupported);
} else {
  if (unsupported.length > 0 && !flag("--allow-unsupported")) {
    report(payload, unsupported);
    throw new Error("Unsupported non-empty tables found; rerun with --allow-unsupported only after reviewing the report.");
  }
  const batchSize = Math.max(1, Math.trunc(Number(arg("--batch-size") ?? "100")));
  const identitySubject = arg("--identity-subject");
  const results = identitySubject === undefined
    ? await importRemote(payload, batchSize)
    : await importLocal(payload, batchSize, identitySubject);
  console.log(JSON.stringify({ result: summarize(results), batches: results.length, counts: Object.fromEntries(payloadKeys.map((key) => [key, payload[key].length])) }, null, 2));
}
