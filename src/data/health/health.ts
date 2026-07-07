import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/database";
import { readSnapshot } from "../shared/snapshots";

export type MacroProfile = {
  id: string;
  goal: string;
  sex: string;
  age: number;
  heightCm: number;
  weightKg: number;
  bodyFatPercent: number | null;
  activityLevel: string;
  birthdate: string | null;
  trainingDaysPerWeek: number;
  targetCalories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  createdAt: string;
  updatedAt: string;
};

export type Meal = {
  id: string;
  name: string;
  mealType: string;
  loggedAt: string;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  source: string;
  notes: string | null;
  items: unknown[];
};

export type Workout = {
  id: string;
  title: string;
  startedAt: string;
  durationSeconds: number;
  notes: string | null;
  source: string;
  exercises: Array<{
    id: string;
    title: string;
    muscleGroups?: string[];
    sets: Array<{
      id: string;
      setType: string;
      reps: number | null;
      weightKg: number | null;
      durationSeconds?: number | null;
      distanceMeters?: number | null;
    }>;
  }>;
};

export type HealthDashboard = {
  macroProfile: MacroProfile | null;
  todayMeals: Meal[];
  recentMeals: Meal[];
  recentWorkouts: Workout[];
  latestCheckin: { weightKg: number; adherencePercent: number; checkedInAt: string } | null;
};

export type MealInput = {
  name: string;
  mealType: string;
  loggedAt: string;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  source: string;
  notes: string | null;
};

type MealRow = {
  id: string;
  name: string;
  meal_type: string;
  logged_at: string;
  calories: number;
  protein_grams: number;
  carbs_grams: number;
  fat_grams: number;
  source: string;
  notes: string | null;
};

type MacroProfileRow = {
  id: string;
  birthdate: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  body_fat_percent: number | null;
  sex: string | null;
  goal: string | null;
  training_days_per_week: number | null;
  activity_level: string | null;
  target_calories: number | null;
  protein_grams: number | null;
  carbs_grams: number | null;
  fat_grams: number | null;
  created_at: string;
  updated_at: string;
};

type WorkoutRow = {
  id: string;
  title: string;
  started_at: string;
  duration_seconds: number;
  notes: string | null;
  source: string;
};

type ExerciseRow = {
  id: string;
  workout_id: string;
  title: string;
  muscle_groups_json: string;
};

type SetRow = {
  id: string;
  workout_exercise_id: string;
  set_type: string;
  reps: number | null;
  weight_kg: number | null;
  duration_seconds: number | null;
  distance_meters: number | null;
};

export function getHealthDashboard(now = new Date()): HealthDashboard {
  return readSnapshot("health_dashboard_snapshot", "health", () => buildHealthDashboard(now), now);
}

function buildHealthDashboard(now: Date): HealthDashboard {
  const today = now.toISOString().slice(0, 10);
  const macroProfile = getActiveMacroProfile(now);
  const todayMeals = getDatabase().query<MealRow, [string]>(`
    SELECT id, name, meal_type, logged_at, calories, protein_grams, carbs_grams, fat_grams, source, notes
    FROM meals
    WHERE substr(logged_at, 1, 10) = ?1
    ORDER BY logged_at DESC
  `).all(today).map(rowToMeal);
  const recentMeals = getDatabase().query<MealRow, []>(`
    SELECT id, name, meal_type, logged_at, calories, protein_grams, carbs_grams, fat_grams, source, notes
    FROM meals
    ORDER BY logged_at DESC
    LIMIT 20
  `).all().map(rowToMeal);
  return { macroProfile, todayMeals, recentMeals, recentWorkouts: listRecentWorkouts(), latestCheckin: null };
}

export function createMeal(input: MealInput, now = new Date()): Meal {
  return saveMeal(randomUUID(), input, now);
}

export function updateMeal(id: string, input: MealInput, now = new Date()): Meal | null {
  if (!getMeal(id)) return null;
  return saveMeal(id, input, now);
}

export function deleteMeal(id: string): boolean {
  return getDatabase().query("DELETE FROM meals WHERE id = ?1").run(id).changes > 0;
}

export function getMeal(id: string): Meal | null {
  const row = getDatabase().query<MealRow, [string]>(`
    SELECT id, name, meal_type, logged_at, calories, protein_grams, carbs_grams, fat_grams, source, notes
    FROM meals
    WHERE id = ?1
  `).get(id);
  return row ? rowToMeal(row) : null;
}

export function parseMealInput(value: unknown): MealInput | null {
  if (!isRecord(value)) return null;
  const name = stringField(value, "name")?.trim();
  const mealType = stringField(value, "mealType")?.trim();
  const loggedAt = stringField(value, "loggedAt");
  if (!name || !mealType || !loggedAt) return null;
  const loggedAtDate = new Date(loggedAt);
  if (Number.isNaN(loggedAtDate.getTime())) return null;
  return {
    name,
    mealType,
    loggedAt: loggedAtDate.toISOString(),
    calories: numberField(value, "calories") ?? 0,
    proteinGrams: numberField(value, "proteinGrams") ?? 0,
    carbsGrams: numberField(value, "carbsGrams") ?? 0,
    fatGrams: numberField(value, "fatGrams") ?? 0,
    source: stringField(value, "source")?.trim() || "manual",
    notes: nullableStringField(value, "notes"),
  };
}

function saveMeal(id: string, input: MealInput, now: Date): Meal {
  const timestamp = now.toISOString();
  getDatabase().query(`
    INSERT INTO meals (id, name, meal_type, logged_at, calories, protein_grams, carbs_grams, fat_grams, source, notes, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      meal_type = excluded.meal_type,
      logged_at = excluded.logged_at,
      calories = excluded.calories,
      protein_grams = excluded.protein_grams,
      carbs_grams = excluded.carbs_grams,
      fat_grams = excluded.fat_grams,
      source = excluded.source,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(id, input.name, input.mealType, input.loggedAt, input.calories, input.proteinGrams, input.carbsGrams, input.fatGrams, input.source, input.notes, timestamp);
  const meal = getMeal(id);
  if (!meal) throw new Error("Saved meal could not be read.");
  return meal;
}

function getActiveMacroProfile(now: Date): MacroProfile | null {
  const row = getDatabase().query<MacroProfileRow, []>(`
    SELECT id, birthdate, height_cm, weight_kg, body_fat_percent, sex, goal, training_days_per_week, activity_level, target_calories, protein_grams, carbs_grams, fat_grams, created_at, updated_at
    FROM macro_profiles
    WHERE active = 1
    ORDER BY updated_at DESC
    LIMIT 1
  `).get();
  if (!row) return null;
  return {
    id: row.id,
    goal: row.goal ?? "maintain",
    sex: row.sex ?? "other",
    age: row.birthdate ? Math.max(0, now.getFullYear() - new Date(row.birthdate).getFullYear()) : 0,
    heightCm: row.height_cm ?? 0,
    weightKg: row.weight_kg ?? 0,
    bodyFatPercent: row.body_fat_percent,
    activityLevel: row.activity_level ?? "unknown",
    birthdate: row.birthdate,
    trainingDaysPerWeek: row.training_days_per_week ?? 0,
    targetCalories: row.target_calories ?? 0,
    proteinGrams: row.protein_grams ?? 0,
    carbsGrams: row.carbs_grams ?? 0,
    fatGrams: row.fat_grams ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listRecentWorkouts(): Workout[] {
  const workouts = getDatabase().query<WorkoutRow, []>(`
    SELECT id, title, started_at, duration_seconds, notes, source
    FROM workouts
    ORDER BY started_at DESC
    LIMIT 10
  `).all();
  return workouts.map((workout) => ({
    id: workout.id,
    title: workout.title,
    startedAt: workout.started_at,
    durationSeconds: workout.duration_seconds,
    notes: workout.notes,
    source: workout.source,
    exercises: listWorkoutExercises(workout.id),
  }));
}

function listWorkoutExercises(workoutId: string): Workout["exercises"] {
  return getDatabase().query<ExerciseRow, [string]>(`
    SELECT id, workout_id, title, muscle_groups_json
    FROM workout_exercises
    WHERE workout_id = ?1
    ORDER BY order_index ASC
  `).all(workoutId).map((exercise) => ({
    id: exercise.id,
    title: exercise.title,
    muscleGroups: parseStringArray(exercise.muscle_groups_json),
    sets: listExerciseSets(exercise.id),
  }));
}

function listExerciseSets(exerciseId: string): Workout["exercises"][number]["sets"] {
  return getDatabase().query<SetRow, [string]>(`
    SELECT id, workout_exercise_id, set_type, reps, weight_kg, duration_seconds, distance_meters
    FROM exercise_sets
    WHERE workout_exercise_id = ?1
    ORDER BY order_index ASC
  `).all(exerciseId).map((set) => ({
    id: set.id,
    setType: set.set_type,
    reps: set.reps,
    weightKg: set.weight_kg,
    durationSeconds: set.duration_seconds,
    distanceMeters: set.distance_meters,
  }));
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rowToMeal(row: MealRow): Meal {
  return {
    id: row.id,
    name: row.name,
    mealType: row.meal_type,
    loggedAt: row.logged_at,
    calories: row.calories,
    proteinGrams: row.protein_grams,
    carbsGrams: row.carbs_grams,
    fatGrams: row.fat_grams,
    source: row.source,
    notes: row.notes,
    items: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function nullableStringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  if (field === null) return null;
  return typeof field === "string" && field.trim() ? field : null;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}
