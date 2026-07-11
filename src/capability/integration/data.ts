import {
  bodyMeasurementExists,
  upsertBodyMeasurement,
  upsertWorkout,
  workoutExists,
  type BodyMeasurementInput,
  type WorkoutInput,
} from "../health/data";
import {
  connectProvider,
  disconnectProvider,
  getProviderConnectionState,
  getProviderDefinition,
  getProviderSecret,
  listProviders,
  type ProviderDefinition,
} from "./providers";
import { getGoogleSettings, saveGoogleSettings } from "./google";

export type IntegrationCatalogEntry = {
  id: string;
  displayName: string;
  category: "life" | "library" | "productivity" | "health" | "finance";
  description: string;
  capabilities: string[];
  authType: "local" | "oauth2" | "token" | "webhook";
  status: "connected" | "pending" | "available" | "unavailable";
  connectProvider?: string;
  setupHint?: string;
};

export function listIntegrations(): {
  integrations: IntegrationCatalogEntry[];
} {
  return { integrations: listProviders().providers.map(providerToIntegration) };
}

export type HevySettings = {
  connected: boolean;
  hasApiKey: boolean;
  lastCheckedAt: string | null;
  secretProvider: string | null;
};

export type IntegrationForbidden = {
  ok: false;
  error: "integration not connected";
  code: "integration_not_connected";
  provider: "hevy";
};

export type HevySyncResult =
  | {
      ok: true;
      fetched: number;
      created: number;
      updated: number;
      measurementsFetched?: number;
      measurementsCreated?: number;
      measurementsUpdated?: number;
    }
  | IntegrationForbidden;

export type HevyRoutineSet = {
  type: string;
  reps: number | null;
  weightKg: number | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
  customMetric: number | null;
  repRange: { start: number | null; end: number | null } | null;
};

export type HevyRoutineExercise = {
  title: string;
  exerciseTemplateId: string | null;
  restSeconds: number | null;
  notes: string | null;
  supersetId: number | null;
  sets: HevyRoutineSet[];
};

export type HevyRoutine = {
  id: string;
  title: string;
  updatedAt: string | null;
  exercises: HevyRoutineExercise[];
};
type HevyRoutineCreateInput = {
  title: string;
  folderId: number | null;
  notes: string | null;
  exercises: HevyRoutineExercise[];
};

export type HevyExerciseTemplate = {
  id: string;
  title: string;
};

type HevyWorkout = {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  exercises?: unknown;
};

type HevyExercise = {
  title?: unknown;
  exercise_template_id?: unknown;
  rest_seconds?: unknown;
  notes?: unknown;
  superset_id?: unknown;
  supersets_id?: unknown;
  sets?: unknown;
};

type HevySet = {
  type?: unknown;
  reps?: unknown;
  weight_kg?: unknown;
  duration_seconds?: unknown;
  distance_meters?: unknown;
  custom_metric?: unknown;
  rep_range?: unknown;
};

type HevyRoutineApiItem = {
  id?: unknown;
  title?: unknown;
  updated_at?: unknown;
  exercises?: unknown;
};

type HevyExerciseTemplateApiItem = {
  id?: unknown;
  title?: unknown;
};
type HevyBodyMeasurement = {
  date?: unknown;
  weight_kg?: unknown;
  lean_mass_kg?: unknown;
  fat_percent?: unknown;
  neck_cm?: unknown;
  shoulder_cm?: unknown;
  chest_cm?: unknown;
  left_bicep_cm?: unknown;
  right_bicep_cm?: unknown;
  left_forearm_cm?: unknown;
  right_forearm_cm?: unknown;
  abdomen?: unknown;
  waist?: unknown;
  hips?: unknown;
  left_thigh?: unknown;
  right_thigh?: unknown;
  left_calf?: unknown;
  right_calf?: unknown;
};

type SyncCounts = { fetched: number; created: number; updated: number };

export function getHevySettings(): HevySettings {
  const provider = getProviderDefinition("hevy");
  const connection = getProviderConnectionState("hevy");
  return {
    connected: provider?.status === "connected",
    hasApiKey: Boolean(provider?.secretProvider),
    lastCheckedAt: connection?.updatedAt ?? null,
    secretProvider: provider?.secretProvider ?? null,
  };
}

export function saveHevySettings(
  input: { apiKey: string },
  now = new Date(),
): HevySettings & { ok: true; status: "connected" } {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("apiKey is required");
  connectProvider(
    "hevy",
    { settings: { configured: true }, secrets: { token: apiKey } },
    now,
  );
  return { ...getHevySettings(), ok: true, status: "connected" };
}

export function disconnectHevy(now = new Date()): { ok: true } {
  disconnectProvider("hevy", now);
  return { ok: true };
}

export async function syncHevy(): Promise<HevySyncResult> {
  const apiKey = getProviderSecret("hevy", "token");
  if (!apiKey) {
    return {
      ok: false,
      error: "integration not connected",
      code: "integration_not_connected",
      provider: "hevy",
    };
  }
  const workouts = await syncHevyWorkouts(apiKey);
  let measurements: SyncCounts | undefined;
  try {
    measurements = await syncHevyBodyMeasurements(apiKey);
  } catch {
    // Older Hevy accounts may not expose body measurements. Workout sync must
    // remain usable; omitted measurement counts make that state explicit.
  }
  return {
    ok: true,
    ...workouts,
    measurementsFetched: measurements?.fetched,
    measurementsCreated: measurements?.created,
    measurementsUpdated: measurements?.updated,
  };
}

async function syncHevyWorkouts(apiKey: string): Promise<SyncCounts> {
  let fetched = 0;
  let created = 0;
  let updated = 0;
  const pageSize = 10;
  for (let page = 1; ; page += 1) {
    const payload = await fetchHevyWorkouts(apiKey, page, pageSize);
    const workouts = Array.isArray(payload.workouts) ? payload.workouts : [];
    fetched += workouts.length;
    for (const workout of workouts) {
      const input = hevyWorkoutToInput(workout);
      if (!input) continue;
      const localWorkoutId = `hevy:${String(workout.id)}`;
      const existed = workoutExists(localWorkoutId);
      upsertWorkout(localWorkoutId, input);
      if (existed) updated += 1;
      else created += 1;
    }
    const pageCount =
      typeof payload.page_count === "number" ? payload.page_count : page;
    if (workouts.length < pageSize || page >= pageCount) break;
  }
  return { fetched, created, updated };
}

async function syncHevyBodyMeasurements(apiKey: string): Promise<SyncCounts> {
  let fetched = 0;
  let created = 0;
  let updated = 0;
  const pageSize = 10;
  for (let page = 1; ; page += 1) {
    const payload = await fetchHevyBodyMeasurements(apiKey, page, pageSize);
    const measurements = Array.isArray(payload.body_measurements)
      ? payload.body_measurements
      : [];
    fetched += measurements.length;
    for (const measurement of measurements) {
      const input = hevyBodyMeasurementToInput(measurement);
      if (!input) continue;
      const id = `hevy:measurement:${input.sourceId}`;
      const existed = bodyMeasurementExists(id);
      upsertBodyMeasurement(id, input);
      if (existed) updated += 1;
      else created += 1;
    }
    const pageCount =
      typeof payload.page_count === "number" ? payload.page_count : page;
    if (measurements.length < pageSize || page >= pageCount) break;
  }
  return { fetched, created, updated };
}

export async function listHevyRoutines(): Promise<
  { routines: HevyRoutine[] } | IntegrationForbidden
> {
  const apiKey = getProviderSecret("hevy", "token");
  if (!apiKey)
    return {
      ok: false,
      error: "integration not connected",
      code: "integration_not_connected",
      provider: "hevy",
    };
  const routines: HevyRoutine[] = [];
  const pageSize = 10;
  for (let page = 1; ; page += 1) {
    const payload = await fetchHevyRoutines(apiKey, page, pageSize);
    const rawRoutines = Array.isArray(payload.routines) ? payload.routines : [];
    const pageRoutines = rawRoutines.flatMap((routine) => {
      const parsed = hevyRoutineToSummary(routine);
      return parsed ? [parsed] : [];
    });
    routines.push(...pageRoutines);
    const pageCount =
      typeof payload.page_count === "number" ? payload.page_count : page;
    if (rawRoutines.length < pageSize || page >= pageCount) break;
  }
  return { routines };
}

export async function listHevyExerciseTemplates(): Promise<
  { exerciseTemplates: HevyExerciseTemplate[] } | IntegrationForbidden
> {
  const apiKey = getProviderSecret("hevy", "token");
  if (!apiKey)
    return {
      ok: false,
      error: "integration not connected",
      code: "integration_not_connected",
      provider: "hevy",
    };
  const exerciseTemplates: HevyExerciseTemplate[] = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const payload = await fetchHevyExerciseTemplates(apiKey, page, pageSize);
    const rawTemplates = Array.isArray(payload.exercise_templates)
      ? payload.exercise_templates
      : [];
    const pageTemplates = rawTemplates.flatMap((template) => {
      const id = stringValue(template.id);
      const title = stringValue(template.title)?.trim();
      return id && title ? [{ id, title }] : [];
    });
    exerciseTemplates.push(...pageTemplates);
    const pageCount =
      typeof payload.page_count === "number" ? payload.page_count : page;
    if (rawTemplates.length < pageSize || page >= pageCount) break;
  }
  return { exerciseTemplates };
}

export async function updateHevyRoutine(
  routineId: string,
  input: unknown,
): Promise<HevyRoutine | IntegrationForbidden> {
  const apiKey = getProviderSecret("hevy", "token");
  if (!apiKey)
    return {
      ok: false,
      error: "integration not connected",
      code: "integration_not_connected",
      provider: "hevy",
    };
  const parsed = parseHevyRoutineUpdate(input);
  if (!parsed) throw new Error("invalid routine");
  const updated = await putHevyRoutine(apiKey, routineId, parsed);
  const routine = hevyRoutineToSummary(updated);
  if (!routine) throw new Error("invalid routine response");
  return routine;
}

export async function createHevyRoutine(
  input: unknown,
): Promise<HevyRoutine | IntegrationForbidden> {
  const apiKey = getProviderSecret("hevy", "token");
  if (!apiKey)
    return {
      ok: false,
      error: "integration not connected",
      code: "integration_not_connected",
      provider: "hevy",
    };
  const parsed = parseHevyRoutineCreate(input);
  if (!parsed) throw new Error("invalid routine");
  const created = await postHevyRoutine(apiKey, parsed);
  const routine = hevyRoutineToSummary(created);
  if (!routine) throw new Error("invalid routine response");
  return routine;
}

async function fetchHevyWorkouts(
  apiKey: string,
  page: number,
  pageSize: number,
): Promise<{ workouts?: HevyWorkout[]; page_count?: number }> {
  const response = await fetch(
    `https://api.hevyapp.com/v1/workouts?page=${page}&pageSize=${pageSize}`,
    {
      headers: { "api-key": apiKey },
    },
  );
  if (!response.ok) {
    throw new Error(`Hevy workout sync failed: ${response.status}`);
  }
  return (await response.json()) as {
    workouts?: HevyWorkout[];
    page_count?: number;
  };
}
async function fetchHevyBodyMeasurements(
  apiKey: string,
  page: number,
  pageSize: number,
): Promise<{
  body_measurements?: HevyBodyMeasurement[];
  page_count?: number;
}> {
  const response = await fetch(
    `https://api.hevyapp.com/v1/body_measurements?page=${page}&pageSize=${pageSize}`,
    { headers: { "api-key": apiKey } },
  );
  if (!response.ok) {
    throw new Error(`Hevy body measurement sync failed: ${response.status}`);
  }
  return (await response.json()) as {
    body_measurements?: HevyBodyMeasurement[];
    page_count?: number;
  };
}

async function fetchHevyRoutines(
  apiKey: string,
  page: number,
  pageSize: number,
): Promise<{ routines?: HevyRoutineApiItem[]; page_count?: number }> {
  const response = await fetch(
    `https://api.hevyapp.com/v1/routines?page=${page}&pageSize=${pageSize}`,
    {
      headers: { "api-key": apiKey },
    },
  );
  if (!response.ok) {
    throw new Error(`Hevy routine fetch failed: ${response.status}`);
  }
  return (await response.json()) as {
    routines?: HevyRoutineApiItem[];
    page_count?: number;
  };
}

async function fetchHevyExerciseTemplates(
  apiKey: string,
  page: number,
  pageSize: number,
): Promise<{
  exercise_templates?: HevyExerciseTemplateApiItem[];
  page_count?: number;
}> {
  const response = await fetch(
    `https://api.hevyapp.com/v1/exercise_templates?page=${page}&pageSize=${pageSize}`,
    {
      headers: { "api-key": apiKey },
    },
  );
  if (!response.ok) {
    throw new Error(`Hevy exercise template fetch failed: ${response.status}`);
  }
  return (await response.json()) as {
    exercise_templates?: HevyExerciseTemplateApiItem[];
    page_count?: number;
  };
}

async function putHevyRoutine(
  apiKey: string,
  routineId: string,
  input: HevyRoutine,
): Promise<HevyRoutineApiItem> {
  const response = await fetch(
    `https://api.hevyapp.com/v1/routines/${encodeURIComponent(routineId)}`,
    {
      method: "PUT",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        routine: {
          title: input.title,
          exercises: input.exercises.map(hevyRoutineExerciseToApi),
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Hevy routine update failed: ${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  return unwrapHevyRoutinePayload(payload);
}

async function postHevyRoutine(
  apiKey: string,
  input: HevyRoutineCreateInput,
): Promise<HevyRoutineApiItem> {
  const routine: Record<string, unknown> = {
    title: input.title,
    exercises: input.exercises.map(hevyRoutineExerciseToApi),
  };
  if (input.folderId !== null) routine.folder_id = input.folderId;
  if (input.notes !== null) routine.notes = input.notes;
  const response = await fetch("https://api.hevyapp.com/v1/routines", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ routine }),
  });
  if (!response.ok) {
    throw new Error(await hevyResponseError(response, "create"));
  }
  const payload = (await response.json()) as unknown;
  return unwrapHevyRoutinePayload(payload);
}

function hevyRoutineExerciseToApi(exercise: HevyRoutineExercise) {
  return {
    exercise_template_id: exercise.exerciseTemplateId,
    superset_id: exercise.supersetId,
    rest_seconds: exercise.restSeconds,
    notes: exercise.notes,
    sets: exercise.sets.map((set) => ({
      type: set.type,
      weight_kg: set.weightKg,
      reps: set.reps,
      distance_meters: set.distanceMeters,
      duration_seconds: set.durationSeconds,
      custom_metric: set.customMetric,
      rep_range: set.repRange,
    })),
  };
}

async function hevyResponseError(
  response: Response,
  action: string,
): Promise<string> {
  const detail = (await response.text()).trim();
  return detail
    ? `Hevy routine ${action} failed: ${response.status} ${detail.slice(0, 300)}`
    : `Hevy routine ${action} failed: ${response.status}`;
}

function unwrapHevyRoutinePayload(payload: unknown): HevyRoutineApiItem {
  const value =
    isRecord(payload) && "routine" in payload ? payload.routine : payload;
  return (Array.isArray(value) ? value[0] : value) as HevyRoutineApiItem;
}

function hevyRoutineToSummary(routine: HevyRoutineApiItem): HevyRoutine | null {
  const id = stringValue(routine.id);
  const title = stringValue(routine.title)?.trim();
  if (!id || !title) return null;
  return {
    id,
    title,
    updatedAt: stringValue(routine.updated_at),
    exercises: parseHevyRoutineExercises(routine.exercises),
  };
}

function hevyWorkoutToInput(workout: HevyWorkout): WorkoutInput | null {
  const id = stringValue(workout.id);
  const title = stringValue(workout.title)?.trim();
  const start = dateValue(workout.start_time);
  if (!id || !title || !start) return null;
  const end = dateValue(workout.end_time);
  return {
    title,
    startedAt: start.toISOString(),
    durationSeconds: end
      ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000))
      : 0,
    notes: stringValue(workout.description),
    source: "hevy",
    exercises: parseHevyExercises(workout.exercises),
  };
}
function hevyBodyMeasurementToInput(
  measurement: HevyBodyMeasurement,
): BodyMeasurementInput | null {
  const date = dateOnlyValue(measurement.date);
  if (!date) return null;
  return {
    source: "hevy",
    sourceId: date,
    recordedAt: `${date}T00:00:00.000Z`,
    weightKg: numberValue(measurement.weight_kg),
    leanMassKg: numberValue(measurement.lean_mass_kg),
    bodyFatPercent: numberValue(measurement.fat_percent),
    neckCm: numberValue(measurement.neck_cm),
    shoulderCm: numberValue(measurement.shoulder_cm),
    chestCm: numberValue(measurement.chest_cm),
    leftBicepCm: numberValue(measurement.left_bicep_cm),
    rightBicepCm: numberValue(measurement.right_bicep_cm),
    leftForearmCm: numberValue(measurement.left_forearm_cm),
    rightForearmCm: numberValue(measurement.right_forearm_cm),
    abdomenCm: numberValue(measurement.abdomen),
    waistCm: numberValue(measurement.waist),
    hipsCm: numberValue(measurement.hips),
    leftThighCm: numberValue(measurement.left_thigh),
    rightThighCm: numberValue(measurement.right_thigh),
    leftCalfCm: numberValue(measurement.left_calf),
    rightCalfCm: numberValue(measurement.right_calf),
  };
}

function parseHevyRoutineExercises(value: unknown): HevyRoutineExercise[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): HevyRoutineExercise[] => {
    if (!isRecord(item)) return [];
    const exercise = item as HevyExercise;
    const title = stringValue(exercise.title)?.trim();
    const exerciseTemplateId = stringValue(exercise.exercise_template_id);
    if (!title || !exerciseTemplateId) return [];
    const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
    return [
      {
        title,
        exerciseTemplateId,
        restSeconds: numberValue(exercise.rest_seconds),
        notes: stringValue(exercise.notes),
        supersetId:
          numberValue(exercise.superset_id) ??
          numberValue(exercise.supersets_id),
        sets: sets.flatMap(parseHevyRoutineSet),
      },
    ];
  });
}

function parseHevyRoutineSet(value: unknown): HevyRoutineSet[] {
  if (!isRecord(value)) return [];
  const hevySet = value as HevySet;
  return [
    {
      type: stringValue(hevySet.type)?.trim() || "normal",
      reps: numberValue(hevySet.reps),
      weightKg: numberValue(hevySet.weight_kg),
      durationSeconds: numberValue(hevySet.duration_seconds),
      distanceMeters: numberValue(hevySet.distance_meters),
      customMetric: numberValue(hevySet.custom_metric),
      repRange: parseRepRange(hevySet.rep_range),
    },
  ];
}

function parseHevyRoutineCreate(value: unknown): HevyRoutineCreateInput | null {
  if (!isRecord(value)) return null;
  const title = stringValue(value.title)?.trim();
  const folderId = optionalNonNegativeNumber(value.folderId);
  const notes = optionalStringValue(value.notes);
  const exercises = parseRoutineCreateExercises(value.exercises);
  if (
    !title ||
    folderId === undefined ||
    notes === undefined ||
    !Array.isArray(value.exercises) ||
    exercises.length !== value.exercises.length ||
    exercises.length === 0
  )
    return null;
  return {
    title,
    folderId,
    notes,
    exercises,
  };
}

function parseHevyRoutineUpdate(value: unknown): HevyRoutine | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const title = stringValue(value.title)?.trim();
  const exercises = parseRoutineUpdateExercises(value.exercises);
  if (!id || !title || exercises.length === 0) return null;
  return {
    id,
    title,
    updatedAt: stringValue(value.updatedAt),
    exercises,
  };
}

function parseRoutineCreateExercises(value: unknown): HevyRoutineExercise[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): HevyRoutineExercise[] => {
    if (!isRecord(item)) return [];
    const exerciseTemplateId = stringValue(item.exerciseTemplateId)?.trim();
    const restSeconds = optionalNonNegativeNumber(item.restSeconds);
    const supersetId = optionalNonNegativeNumber(item.supersetId);
    const sets = parseRoutineCreateSets(item.sets);
    const rawSets = Array.isArray(item.sets) ? item.sets : null;
    if (
      !exerciseTemplateId ||
      restSeconds === undefined ||
      supersetId === undefined ||
      !rawSets ||
      sets.length !== rawSets.length ||
      sets.length === 0
    )
      return [];
    return [
      {
        title: stringValue(item.title)?.trim() || exerciseTemplateId,
        exerciseTemplateId,
        restSeconds,
        notes: optionalString(item.notes),
        supersetId,
        sets,
      },
    ];
  });
}

function parseRoutineCreateSets(value: unknown): HevyRoutineSet[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): HevyRoutineSet[] => {
    if (!isRecord(item)) return [];
    const type = stringValue(item.type)?.trim();
    if (!isHevySetType(type)) return [];
    const reps = optionalNonNegativeNumber(item.reps);
    const weightKg = optionalNonNegativeNumber(item.weightKg);
    const durationSeconds = optionalNonNegativeNumber(item.durationSeconds);
    const distanceMeters = optionalNonNegativeNumber(item.distanceMeters);
    const customMetric = optionalNonNegativeNumber(item.customMetric);
    const repRange = parseCreateRepRange(item.repRange);
    if (
      reps === undefined ||
      weightKg === undefined ||
      durationSeconds === undefined ||
      distanceMeters === undefined ||
      customMetric === undefined ||
      repRange === undefined
    )
      return [];
    return [
      {
        type,
        reps,
        weightKg,
        durationSeconds,
        distanceMeters,
        customMetric,
        repRange,
      },
    ];
  });
}

function parseRoutineUpdateExercises(value: unknown): HevyRoutineExercise[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): HevyRoutineExercise[] => {
    if (!isRecord(item)) return [];
    const title = stringValue(item.title)?.trim();
    const exerciseTemplateId = stringValue(item.exerciseTemplateId);
    if (!title || !exerciseTemplateId) return [];
    return [
      {
        title,
        exerciseTemplateId,
        restSeconds: numberValue(item.restSeconds),
        notes: stringValue(item.notes),
        supersetId: numberValue(item.supersetId),
        sets: parseRoutineUpdateSets(item.sets),
      },
    ];
  });
}

function parseRoutineUpdateSets(value: unknown): HevyRoutineSet[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): HevyRoutineSet[] => {
    if (!isRecord(item)) return [];
    return [
      {
        type: stringValue(item.type)?.trim() || "normal",
        reps: numberValue(item.reps),
        weightKg: numberValue(item.weightKg),
        durationSeconds: numberValue(item.durationSeconds),
        distanceMeters: numberValue(item.distanceMeters),
        customMetric: numberValue(item.customMetric),
        repRange: parseRepRange(item.repRange),
      },
    ];
  });
}

function parseCreateRepRange(
  value: unknown,
): HevyRoutineSet["repRange"] | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  const start = optionalNonNegativeNumber(value.start);
  const end = optionalNonNegativeNumber(value.end);
  return start === undefined || end === undefined ? undefined : { start, end };
}

function parseRepRange(value: unknown): HevyRoutineSet["repRange"] {
  if (!isRecord(value)) return null;
  return {
    start: numberValue(value.start),
    end: numberValue(value.end),
  };
}

function parseHevyExercises(value: unknown): WorkoutInput["exercises"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): WorkoutInput["exercises"] => {
    if (!isRecord(item)) return [];
    const exercise = item as HevyExercise;
    const title = stringValue(exercise.title)?.trim();
    if (!title) return [];
    const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
    return [
      {
        title,
        muscleGroups: [],
        sets: sets.flatMap((set): WorkoutInput["exercises"][number]["sets"] => {
          if (!isRecord(set)) return [];
          const hevySet = set as HevySet;
          return [
            {
              setType: stringValue(hevySet.type)?.trim() || "normal",
              reps: numberValue(hevySet.reps),
              weightKg: numberValue(hevySet.weight_kg),
              durationSeconds: numberValue(hevySet.duration_seconds),
              distanceMeters: numberValue(hevySet.distance_meters),
            },
          ];
        }),
      },
    ];
  });
}

function dateOnlyValue(value: unknown): string | null {
  const text = stringValue(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== text
    ? null
    : text;
}

function dateValue(value: unknown): Date | null {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalNonNegativeNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalStringValue(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

function isHevySetType(
  value: string | null | undefined,
): value is "warmup" | "normal" | "failure" | "dropset" {
  return (
    value === "warmup" ||
    value === "normal" ||
    value === "failure" ||
    value === "dropset"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function getGoogleIntegrationSettings() {
  return getGoogleSettings();
}

export function saveGoogleIntegrationSettings(input: unknown) {
  return saveGoogleSettings(input);
}

export function disconnectGoogle(): { ok: true } {
  disconnectProvider("google");
  return { ok: true };
}

export function parseHevySettings(value: unknown): { apiKey: string } | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("apiKey" in value) ||
    typeof value.apiKey !== "string"
  )
    return null;
  const apiKey = value.apiKey.trim();
  return apiKey ? { apiKey } : null;
}

function providerToIntegration(
  provider: ProviderDefinition,
): IntegrationCatalogEntry {
  return {
    id: provider.id,
    displayName: provider.displayName,
    category: provider.category,
    description: providerDescription(provider.id),
    capabilities: provider.capabilities,
    authType: provider.authType,
    status: provider.status,
    connectProvider: provider.authType === "oauth2" ? provider.id : undefined,
    setupHint: setupHint(provider.id),
  };
}

function setupHint(providerId: string): string {
  if (providerId === "google")
    return getGoogleSettings().hasClientConfig
      ? "Ready to connect through Google OAuth."
      : "Save OAuth client credentials to connect.";
  if (providerId === "hevy")
    return getHevySettings().hasApiKey
      ? "Ready to sync workouts."
      : "Save API key to sync workouts.";
  return "Configure provider settings.";
}

function providerDescription(providerId: string): string {
  if (providerId === "google")
    return "Google Calendar, Tasks, and workspace data.";
  if (providerId === "spotify")
    return "Now-playing context for focus sessions.";
  if (providerId === "hevy") return "Workout sync for health dashboards.";
  return "Registered local provider.";
}
