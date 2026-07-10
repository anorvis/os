import { randomUUID } from "node:crypto";
import { decodeUnknown, decodeUnknownResult } from "../../core/effect/schema";
import { getDatabase } from "../../core/db/database";
import { readSnapshot } from "../../core/snapshots/snapshots";
import {
  HealthJsonObjectSchema,
  HealthStringArrayJsonSchema,
  MealInputBodySchema,
  WorkoutInputBodySchema,
} from "./schema";

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

export type BodyMeasurement = {
  id: string;
  source: string;
  weightKg: number | null;
  leanMassKg: number | null;
  bodyFatPercent: number | null;
  heightCm: number | null;
  neckCm: number | null;
  shoulderCm: number | null;
  chestCm: number | null;
  leftBicepCm: number | null;
  rightBicepCm: number | null;
  leftForearmCm: number | null;
  rightForearmCm: number | null;
  abdomenCm: number | null;
  waistCm: number | null;
  hipsCm: number | null;
  leftThighCm: number | null;
  rightThighCm: number | null;
  leftCalfCm: number | null;
  rightCalfCm: number | null;
  recordedAt: string;
};

export type BodyMeasurementInput = Omit<BodyMeasurement, "id" | "heightCm"> & {
  sourceId: string;
};

export type HealthDashboard = {
  macroProfile: MacroProfile | null;
  todayMeals: Meal[];
  recentMeals: Meal[];
  recentWorkouts: Workout[];
  measurementHistory: BodyMeasurement[];
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

export type MacroProfileInput = Omit<
  MacroProfile,
  "id" | "createdAt" | "updatedAt"
>;

export type WorkoutInput = {
  title: string;
  startedAt: string;
  durationSeconds: number;
  notes: string | null;
  source: string;
  exercises: Array<{
    title: string;
    muscleGroups?: string[];
    sets: Array<{
      setType: string;
      reps: number | null;
      weightKg: number | null;
      durationSeconds?: number | null;
      distanceMeters?: number | null;
    }>;
  }>;
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
type BodyMeasurementRow = {
  id: string;
  source: string;
  recorded_at: string;
  weight_kg: number | null;
  lean_mass_kg: number | null;
  fat_percent: number | null;
  neck_cm: number | null;
  shoulder_cm: number | null;
  chest_cm: number | null;
  left_bicep_cm: number | null;
  right_bicep_cm: number | null;
  left_forearm_cm: number | null;
  right_forearm_cm: number | null;
  abdomen_cm: number | null;
  waist_cm: number | null;
  hips_cm: number | null;
  left_thigh_cm: number | null;
  right_thigh_cm: number | null;
  left_calf_cm: number | null;
  right_calf_cm: number | null;
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
  return readSnapshot(
    "health_dashboard_snapshot",
    "health",
    () => buildHealthDashboard(now),
    now,
  );
}

function buildHealthDashboard(now: Date): HealthDashboard {
  const today = now.toISOString().slice(0, 10);
  const macroProfile = getActiveMacroProfile(now);
  const todayMeals = getDatabase()
    .query<MealRow, [string]>(`
    SELECT id, name, meal_type, logged_at, calories, protein_grams, carbs_grams, fat_grams, source, notes
    FROM meals
    WHERE substr(logged_at, 1, 10) = ?1
    ORDER BY logged_at DESC
  `)
    .all(today)
    .map(rowToMeal);
  const recentMeals = getDatabase()
    .query<MealRow, []>(`
    SELECT id, name, meal_type, logged_at, calories, protein_grams, carbs_grams, fat_grams, source, notes
    FROM meals
    ORDER BY logged_at DESC
    LIMIT 100
  `)
    .all()
    .map(rowToMeal);
  return {
    macroProfile,
    todayMeals,
    recentMeals,
    recentWorkouts: listRecentWorkouts(),
    measurementHistory: listMeasurementHistory(),
  };
}

export function listMeasurementHistory(): HealthDashboard["measurementHistory"] {
  const profileMeasurements = getDatabase()
    .query<
      {
        id: string;
        weight_kg: number | null;
        body_fat_percent: number | null;
        height_cm: number | null;
        updated_at: string;
      },
      []
    >(`
      SELECT id, weight_kg, body_fat_percent, height_cm, updated_at
      FROM macro_profiles
    `)
    .all()
    .map((row): BodyMeasurement => ({
      id: row.id,
      source: "manual",
      weightKg: row.weight_kg,
      leanMassKg: null,
      bodyFatPercent: row.body_fat_percent,
      heightCm: row.height_cm,
      neckCm: null,
      shoulderCm: null,
      chestCm: null,
      leftBicepCm: null,
      rightBicepCm: null,
      leftForearmCm: null,
      rightForearmCm: null,
      abdomenCm: null,
      waistCm: null,
      hipsCm: null,
      leftThighCm: null,
      rightThighCm: null,
      leftCalfCm: null,
      rightCalfCm: null,
      recordedAt: row.updated_at,
    }));
  const syncedMeasurements = getDatabase()
    .query<BodyMeasurementRow, []>(`
      SELECT id, source, recorded_at, weight_kg, lean_mass_kg, fat_percent,
        neck_cm, shoulder_cm, chest_cm, left_bicep_cm, right_bicep_cm,
        left_forearm_cm, right_forearm_cm, abdomen_cm, waist_cm, hips_cm,
        left_thigh_cm, right_thigh_cm, left_calf_cm, right_calf_cm
      FROM body_measurements
    `)
    .all()
    .map(rowToBodyMeasurement);
  return [...profileMeasurements, ...syncedMeasurements].sort((left, right) =>
    left.recordedAt.localeCompare(right.recordedAt),
  );
}

export function bodyMeasurementExists(id: string): boolean {
  return Boolean(
    getDatabase()
      .query<{ id: string }, [string]>(
        "SELECT id FROM body_measurements WHERE id = ?1",
      )
      .get(id),
  );
}

export function upsertBodyMeasurement(
  id: string,
  input: BodyMeasurementInput,
  now = new Date(),
): BodyMeasurement {
  const timestamp = now.toISOString();
  getDatabase()
    .query(`
      INSERT INTO body_measurements (
        id, source, source_id, recorded_at, weight_kg, lean_mass_kg, fat_percent,
        neck_cm, shoulder_cm, chest_cm, left_bicep_cm, right_bicep_cm,
        left_forearm_cm, right_forearm_cm, abdomen_cm, waist_cm, hips_cm,
        left_thigh_cm, right_thigh_cm, left_calf_cm, right_calf_cm,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
        ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?22
      )
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        source_id = excluded.source_id,
        recorded_at = excluded.recorded_at,
        weight_kg = excluded.weight_kg,
        lean_mass_kg = excluded.lean_mass_kg,
        fat_percent = excluded.fat_percent,
        neck_cm = excluded.neck_cm,
        shoulder_cm = excluded.shoulder_cm,
        chest_cm = excluded.chest_cm,
        left_bicep_cm = excluded.left_bicep_cm,
        right_bicep_cm = excluded.right_bicep_cm,
        left_forearm_cm = excluded.left_forearm_cm,
        right_forearm_cm = excluded.right_forearm_cm,
        abdomen_cm = excluded.abdomen_cm,
        waist_cm = excluded.waist_cm,
        hips_cm = excluded.hips_cm,
        left_thigh_cm = excluded.left_thigh_cm,
        right_thigh_cm = excluded.right_thigh_cm,
        left_calf_cm = excluded.left_calf_cm,
        right_calf_cm = excluded.right_calf_cm,
        updated_at = excluded.updated_at
    `)
    .run(
      id,
      input.source,
      input.sourceId,
      input.recordedAt,
      input.weightKg,
      input.leanMassKg,
      input.bodyFatPercent,
      input.neckCm,
      input.shoulderCm,
      input.chestCm,
      input.leftBicepCm,
      input.rightBicepCm,
      input.leftForearmCm,
      input.rightForearmCm,
      input.abdomenCm,
      input.waistCm,
      input.hipsCm,
      input.leftThighCm,
      input.rightThighCm,
      input.leftCalfCm,
      input.rightCalfCm,
      timestamp,
    );
  const row = getDatabase()
    .query<BodyMeasurementRow, [string]>(`
      SELECT id, source, recorded_at, weight_kg, lean_mass_kg, fat_percent,
        neck_cm, shoulder_cm, chest_cm, left_bicep_cm, right_bicep_cm,
        left_forearm_cm, right_forearm_cm, abdomen_cm, waist_cm, hips_cm,
        left_thigh_cm, right_thigh_cm, left_calf_cm, right_calf_cm
      FROM body_measurements
      WHERE id = ?1
    `)
    .get(id);
  if (!row) throw new Error("Saved body measurement could not be read.");
  return rowToBodyMeasurement(row);
}

function rowToBodyMeasurement(row: BodyMeasurementRow): BodyMeasurement {
  return {
    id: row.id,
    source: row.source,
    weightKg: row.weight_kg,
    leanMassKg: row.lean_mass_kg,
    bodyFatPercent: row.fat_percent,
    heightCm: null,
    neckCm: row.neck_cm,
    shoulderCm: row.shoulder_cm,
    chestCm: row.chest_cm,
    leftBicepCm: row.left_bicep_cm,
    rightBicepCm: row.right_bicep_cm,
    leftForearmCm: row.left_forearm_cm,
    rightForearmCm: row.right_forearm_cm,
    abdomenCm: row.abdomen_cm,
    waistCm: row.waist_cm,
    hipsCm: row.hips_cm,
    leftThighCm: row.left_thigh_cm,
    rightThighCm: row.right_thigh_cm,
    leftCalfCm: row.left_calf_cm,
    rightCalfCm: row.right_calf_cm,
    recordedAt: row.recorded_at,
  };
}

export function createMeal(input: MealInput, now = new Date()): Meal {
  return saveMeal(randomUUID(), input, now);
}

export function updateMeal(
  id: string,
  input: MealInput,
  now = new Date(),
): Meal | null {
  if (!getMeal(id)) return null;
  return saveMeal(id, input, now);
}

export function deleteMeal(id: string): boolean {
  return (
    getDatabase().query("DELETE FROM meals WHERE id = ?1").run(id).changes > 0
  );
}

export function getMeal(id: string): Meal | null {
  const row = getDatabase()
    .query<MealRow, [string]>(`
    SELECT id, name, meal_type, logged_at, calories, protein_grams, carbs_grams, fat_grams, source, notes
    FROM meals
    WHERE id = ?1
  `)
    .get(id);
  return row ? rowToMeal(row) : null;
}

export function parseMealInput(value: unknown): MealInput | null {
  const decoded = decodeUnknownResult(MealInputBodySchema, value);
  if (!decoded.ok) return null;
  const input = decoded.value;
  const name = input.name.trim();
  const mealType = input.mealType.trim();
  const loggedAt = input.loggedAt;
  if (!name || !mealType) return null;
  const loggedAtDate = new Date(loggedAt);
  if (Number.isNaN(loggedAtDate.getTime())) return null;
  return {
    name,
    mealType,
    loggedAt: loggedAtDate.toISOString(),
    calories: numberValue(input.calories) ?? 0,
    proteinGrams: numberValue(input.proteinGrams) ?? 0,
    carbsGrams: numberValue(input.carbsGrams) ?? 0,
    fatGrams: numberValue(input.fatGrams) ?? 0,
    source: stringValue(input.source)?.trim() || "manual",
    notes: nullableStringValue(input.notes),
  };
}

function saveMeal(id: string, input: MealInput, now: Date): Meal {
  const timestamp = now.toISOString();
  getDatabase()
    .query(`
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
  `)
    .run(
      id,
      input.name,
      input.mealType,
      input.loggedAt,
      input.calories,
      input.proteinGrams,
      input.carbsGrams,
      input.fatGrams,
      input.source,
      input.notes,
      timestamp,
    );
  const meal = getMeal(id);
  if (!meal) throw new Error("Saved meal could not be read.");
  return meal;
}

export function saveMacroProfile(
  input: MacroProfileInput,
  now = new Date(),
): MacroProfile {
  const timestamp = now.toISOString();
  const id = randomUUID();
  getDatabase()
    .query("UPDATE macro_profiles SET active = 0 WHERE active = 1")
    .run();
  getDatabase()
    .query(`
    INSERT INTO macro_profiles (
      id, active, birthdate, height_cm, weight_kg, body_fat_percent, sex, goal,
      training_days_per_week, activity_level, target_calories, protein_grams,
      carbs_grams, fat_grams, created_at, updated_at
    )
    VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
  `)
    .run(
      id,
      input.birthdate,
      input.heightCm,
      input.weightKg,
      input.bodyFatPercent,
      input.sex,
      input.goal,
      input.trainingDaysPerWeek,
      input.activityLevel,
      input.targetCalories,
      input.proteinGrams,
      input.carbsGrams,
      input.fatGrams,
      timestamp,
    );
  const profile = getActiveMacroProfile(now);
  if (!profile) throw new Error("Saved macro profile could not be read.");
  return profile;
}

export function parseMacroProfileInput(
  value: unknown,
): MacroProfileInput | null {
  const decoded = decodeUnknownResult(HealthJsonObjectSchema, value);
  if (!decoded.ok) return null;
  const input = decoded.value;
  const goal = stringField(input, "goal")?.trim();
  const sex = stringField(input, "sex")?.trim();
  const age = numberField(input, "age");
  const heightCm = numberField(input, "heightCm");
  const weightKg = numberField(input, "weightKg");
  const activityLevel = stringField(input, "activityLevel")?.trim();
  const trainingDaysPerWeek = numberField(input, "trainingDaysPerWeek");
  const targetCalories = numberField(input, "targetCalories");
  const proteinGrams = numberField(input, "proteinGrams");
  const carbsGrams = numberField(input, "carbsGrams");
  const fatGrams = numberField(input, "fatGrams");
  if (
    !goal ||
    !sex ||
    age === undefined ||
    heightCm === undefined ||
    weightKg === undefined ||
    !activityLevel ||
    trainingDaysPerWeek === undefined ||
    targetCalories === undefined ||
    proteinGrams === undefined ||
    carbsGrams === undefined ||
    fatGrams === undefined
  ) {
    return null;
  }
  return {
    goal,
    sex,
    age,
    heightCm,
    weightKg,
    bodyFatPercent: numberField(input, "bodyFatPercent") ?? null,
    activityLevel,
    birthdate: nullableStringField(input, "birthdate"),
    trainingDaysPerWeek,
    targetCalories,
    proteinGrams,
    carbsGrams,
    fatGrams,
  };
}

function getActiveMacroProfile(now: Date): MacroProfile | null {
  const row = getDatabase()
    .query<MacroProfileRow, []>(`
    SELECT id, birthdate, height_cm, weight_kg, body_fat_percent, sex, goal, training_days_per_week, activity_level, target_calories, protein_grams, carbs_grams, fat_grams, created_at, updated_at
    FROM macro_profiles
    WHERE active = 1
    ORDER BY updated_at DESC
    LIMIT 1
  `)
    .get();
  if (!row) return null;
  return {
    id: row.id,
    goal: row.goal ?? "maintain",
    sex: row.sex ?? "other",
    age: row.birthdate
      ? Math.max(0, now.getFullYear() - new Date(row.birthdate).getFullYear())
      : 0,
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

export function createWorkout(input: WorkoutInput, now = new Date()): Workout {
  return saveWorkout(randomUUID(), input, now);
}

export function upsertWorkout(
  id: string,
  input: WorkoutInput,
  now = new Date(),
): Workout {
  return saveWorkout(id, input, now);
}

export function updateWorkout(
  id: string,
  input: WorkoutInput,
  now = new Date(),
): Workout | null {
  if (!getWorkout(id)) return null;
  return saveWorkout(id, input, now);
}

export function workoutExists(id: string): boolean {
  return Boolean(getWorkout(id));
}

export function parseWorkoutInput(value: unknown): WorkoutInput | null {
  const decoded = decodeUnknownResult(WorkoutInputBodySchema, value);
  if (!decoded.ok) return null;
  const input = decoded.value;
  const title = input.title.trim();
  const startedAt = input.startedAt;
  if (!title) return null;
  const startedAtDate = new Date(startedAt);
  if (Number.isNaN(startedAtDate.getTime())) return null;
  const rawExercises = Array.isArray(input.exercises) ? input.exercises : [];
  return {
    title,
    startedAt: startedAtDate.toISOString(),
    durationSeconds: numberValue(input.durationSeconds) ?? 0,
    notes: nullableStringValue(input.notes),
    source: stringValue(input.source)?.trim() || "manual",
    exercises: rawExercises.flatMap((exercise): WorkoutInput["exercises"] => {
      if (!isRecord(exercise)) return [];
      const exerciseTitle = stringField(exercise, "title")?.trim();
      if (!exerciseTitle) return [];
      const rawSets = Array.isArray(exercise.sets) ? exercise.sets : [];
      return [
        {
          title: exerciseTitle,
          muscleGroups: parseStringArrayField(exercise.muscleGroups),
          sets: rawSets.flatMap(
            (set): WorkoutInput["exercises"][number]["sets"] => {
              if (!isRecord(set)) return [];
              return [
                {
                  setType: stringField(set, "setType")?.trim() || "normal",
                  reps: numberField(set, "reps") ?? null,
                  weightKg: numberField(set, "weightKg") ?? null,
                  durationSeconds: numberField(set, "durationSeconds") ?? null,
                  distanceMeters: numberField(set, "distanceMeters") ?? null,
                },
              ];
            },
          ),
        },
      ];
    }),
  };
}

function getWorkout(id: string): Workout | null {
  const workout = getDatabase()
    .query<WorkoutRow, [string]>(`
    SELECT id, title, started_at, duration_seconds, notes, source
    FROM workouts
    WHERE id = ?1
  `)
    .get(id);
  if (!workout) return null;
  return {
    id: workout.id,
    title: workout.title,
    startedAt: workout.started_at,
    durationSeconds: workout.duration_seconds,
    notes: workout.notes,
    source: workout.source,
    exercises: listWorkoutExercises(workout.id),
  };
}

function saveWorkout(id: string, input: WorkoutInput, now: Date): Workout {
  const timestamp = now.toISOString();
  getDatabase()
    .query(`
    INSERT INTO workouts (id, source, title, started_at, duration_seconds, notes, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      title = excluded.title,
      started_at = excluded.started_at,
      duration_seconds = excluded.duration_seconds,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `)
    .run(
      id,
      input.source,
      input.title,
      input.startedAt,
      input.durationSeconds,
      input.notes,
      timestamp,
    );
  getDatabase()
    .query(
      "DELETE FROM exercise_sets WHERE workout_exercise_id IN (SELECT id FROM workout_exercises WHERE workout_id = ?1)",
    )
    .run(id);
  getDatabase()
    .query("DELETE FROM workout_exercises WHERE workout_id = ?1")
    .run(id);
  const insertExercise = getDatabase().query(`
    INSERT INTO workout_exercises (id, workout_id, title, muscle_groups_json, order_index)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `);
  const insertSet = getDatabase().query(`
    INSERT INTO exercise_sets (id, workout_exercise_id, set_type, reps, weight_kg, duration_seconds, distance_meters, order_index)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  `);
  input.exercises.forEach((exercise, exerciseIndex) => {
    const exerciseId = randomUUID();
    insertExercise.run(
      exerciseId,
      id,
      exercise.title,
      JSON.stringify(exercise.muscleGroups ?? []),
      exerciseIndex,
    );
    exercise.sets.forEach((set, setIndex) => {
      insertSet.run(
        randomUUID(),
        exerciseId,
        set.setType,
        set.reps,
        set.weightKg,
        set.durationSeconds ?? null,
        set.distanceMeters ?? null,
        setIndex,
      );
    });
  });
  const workout = getWorkout(id);
  if (!workout) throw new Error("Saved workout could not be read.");
  return workout;
}

function listRecentWorkouts(): Workout[] {
  const workouts = getDatabase()
    .query<WorkoutRow, []>(`
    SELECT id, title, started_at, duration_seconds, notes, source
    FROM workouts
    ORDER BY started_at DESC
    LIMIT 100
  `)
    .all();
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

export function listWorkoutsInRange(input: {
  timeMin?: string | null;
  timeMax?: string | null;
}): Workout[] {
  const workouts = getDatabase()
    .query<WorkoutRow, [string | null, string | null]>(`
    SELECT id, title, started_at, duration_seconds, notes, source
    FROM workouts
    WHERE (?1 IS NULL OR datetime(started_at, '+' || duration_seconds || ' seconds') >= datetime(?1))
      AND (?2 IS NULL OR datetime(started_at) <= datetime(?2))
    ORDER BY started_at ASC
  `)
    .all(input.timeMin ?? null, input.timeMax ?? null);
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
  return getDatabase()
    .query<ExerciseRow, [string]>(`
    SELECT id, workout_id, title, muscle_groups_json
    FROM workout_exercises
    WHERE workout_id = ?1
    ORDER BY order_index ASC
  `)
    .all(workoutId)
    .map((exercise) => ({
      id: exercise.id,
      title: exercise.title,
      muscleGroups: parseStringArray(exercise.muscle_groups_json),
      sets: listExerciseSets(exercise.id),
    }));
}

function listExerciseSets(
  exerciseId: string,
): Workout["exercises"][number]["sets"] {
  return getDatabase()
    .query<SetRow, [string]>(`
    SELECT id, workout_exercise_id, set_type, reps, weight_kg, duration_seconds, distance_meters
    FROM exercise_sets
    WHERE workout_exercise_id = ?1
    ORDER BY order_index ASC
  `)
    .all(exerciseId)
    .map((set) => ({
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
    return [...decodeUnknown(HealthStringArrayJsonSchema, value)];
  } catch {
    return [];
  }
}

function parseStringArrayField(value: unknown): string[] {
  if (typeof value === "string") return parseStringArray(value);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return decodeUnknownResult(HealthJsonObjectSchema, value).ok;
}

export function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

export function nullableStringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  if (field === null) return null;
  return typeof field === "string" && field.trim() ? field : null;
}

export function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function nullableStringValue(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === "string" && value.trim() ? value : null;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
