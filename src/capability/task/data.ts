import { randomUUID } from "node:crypto";
import { decodeUnknown, decodeUnknownResult } from "../../core/effect/schema";
import { getDatabase } from "../../core/db/database";
import { StoredTaskLinksSchema, TaskInputBodySchema, TaskJsonObjectSchema, TaskPrioritySchema, TaskStatusSchema, type TaskPriority, type TaskStatus } from "./schema";


export type Task = {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority | null;
  dueAt: string | null;
  source: string;
  sourceId: string | null;
  durationMinutes: number | null;
  completedAt: string | null;
  links: string[];
  multiSession: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TaskSession = {
  id: string;
  taskId: string;
  startAt: string;
  endAt: string;
  status: "planned" | "completed" | "cancelled";
  source: string;
  createdAt: string;
  updatedAt: string;
};

type TaskRow = {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  priority: string | null;
  due_at: string | null;
  source: string;
  source_id: string | null;
  duration_minutes: number | null;
  links_json: string | null;
  multi_session: number | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type TaskSessionRow = {
  id: string;
  task_id: string;
  start_at: string;
  end_at: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
};

export type TaskInput = {
  title: string;
  notes?: string | null;
  dueAt?: string | null;
  priority?: TaskPriority;
  durationMinutes?: number | null;
  links?: string[];
  multiSession?: boolean;
  source?: string;
};

export type TaskPatch = Partial<TaskInput> & {
  links?: string[];
  multiSession?: boolean;
  completedAt?: string | null;
  status?: TaskStatus;
};

export function listTasks(): Task[] {
  return getDatabase().query<TaskRow, []>(`
    SELECT id, title, notes, status, priority, due_at, source, source_id, duration_minutes, links_json, multi_session, completed_at, created_at, updated_at
    FROM tasks
    ORDER BY status ASC, due_at IS NULL ASC, due_at ASC, updated_at DESC
  `).all().map(rowToTask);
}

export function createTask(input: TaskInput, now = new Date()): Task {
  const task = normalizeTaskInput(input);
  const timestamp = now.toISOString();
  const id = randomUUID();
  getDatabase().query(`
    INSERT INTO tasks (id, title, notes, status, priority, due_at, source, duration_minutes, links_json, multi_session, created_at, updated_at)
    VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
  `).run(id, task.title, task.notes ?? null, task.priority ?? null, task.dueAt ?? null, task.source, task.durationMinutes ?? null, JSON.stringify(task.links), task.multiSession ? 1 : 0, timestamp);
  const created = getTask(id);
  if (!created) throw new Error("Created task could not be read.");
  return created;
}

export function getTask(id: string): Task | null {
  const row = getDatabase().query<TaskRow, [string]>(`
    SELECT id, title, notes, status, priority, due_at, source, source_id, duration_minutes, links_json, multi_session, completed_at, created_at, updated_at
    FROM tasks
    WHERE id = ?1
  `).get(id);
  return row ? rowToTask(row) : null;
}

export function updateTask(id: string, patch: TaskPatch, now = new Date()): Task | null {
  const existing = getTask(id);
  if (!existing) return null;
  const normalized = normalizeTaskPatch(patch);
  const next = {
    title: normalized.title ?? existing.title,
    notes: Object.prototype.hasOwnProperty.call(normalized, "notes") ? normalized.notes ?? null : existing.notes,
    status: normalized.status ?? existing.status,
    priority: Object.prototype.hasOwnProperty.call(normalized, "priority") ? normalized.priority ?? null : existing.priority,
    dueAt: Object.prototype.hasOwnProperty.call(normalized, "dueAt") ? normalized.dueAt ?? null : existing.dueAt,
    durationMinutes: Object.prototype.hasOwnProperty.call(normalized, "durationMinutes") ? normalized.durationMinutes ?? null : existing.durationMinutes,
    links: Object.prototype.hasOwnProperty.call(normalized, "links") ? normalized.links ?? [] : existing.links,
    multiSession: Object.prototype.hasOwnProperty.call(normalized, "multiSession") ? normalized.multiSession ?? false : existing.multiSession,
    completedAt: Object.prototype.hasOwnProperty.call(normalized, "completedAt") ? normalized.completedAt ?? null : existing.completedAt,
  };
  getDatabase().query(`
    UPDATE tasks
    SET title = ?2, notes = ?3, status = ?4, priority = ?5, due_at = ?6, duration_minutes = ?7, links_json = ?8, multi_session = ?9, completed_at = ?10, updated_at = ?11
    WHERE id = ?1
  `).run(id, next.title, next.notes, next.status, next.priority, next.dueAt, next.durationMinutes, JSON.stringify(next.links), next.multiSession ? 1 : 0, next.completedAt, now.toISOString());
  return getTask(id);
}

export function completeTask(id: string, now = new Date()): Task | null {
  return updateTask(id, { status: "completed", completedAt: now.toISOString() }, now);
}

export function deleteTask(id: string): boolean {
  return getDatabase().query("DELETE FROM tasks WHERE id = ?1").run(id).changes > 0;
}

export function upsertTaskSession(id: string, input: { startAt: string; endAt: string }, now = new Date()): TaskSession | null {
  const startAt = normalizeDate(input.startAt, "startAt");
  const endAt = normalizeDate(input.endAt, "endAt");
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) throw new Error("endAt must be after startAt");
  const existing = getTaskSession(id);
  const timestamp = now.toISOString();
  if (existing) {
    getDatabase().query("UPDATE task_sessions SET start_at = ?2, end_at = ?3, updated_at = ?4 WHERE id = ?1").run(id, startAt, endAt, timestamp);
    return getTaskSession(id);
  }
  const task = getTask(id);
  const taskId = task ? task.id : createTask({ title: "Scheduled task", source: "agent" }, now).id;
  getDatabase().query(`
    INSERT INTO task_sessions (id, task_id, start_at, end_at, status, source, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 'planned', 'manual', ?5, ?5)
  `).run(id, taskId, startAt, endAt, timestamp);
  return getTaskSession(id);
}

export function listTaskSessions(input: { timeMin?: string; timeMax?: string } = {}): TaskSession[] {
  return getDatabase().query<TaskSessionRow, [string | null, string | null]>(`
    SELECT id, task_id, start_at, end_at, status, source, created_at, updated_at
    FROM task_sessions
    WHERE (?1 IS NULL OR end_at >= ?1)
      AND (?2 IS NULL OR start_at <= ?2)
    ORDER BY start_at ASC, created_at ASC
  `).all(input.timeMin ?? null, input.timeMax ?? null).map(rowToTaskSession);
}

export function getTaskSession(id: string): TaskSession | null {
  const row = getDatabase().query<TaskSessionRow, [string]>(`
    SELECT id, task_id, start_at, end_at, status, source, created_at, updated_at
    FROM task_sessions
    WHERE id = ?1
  `).get(id);
  return row ? rowToTaskSession(row) : null;
}

export function parseTaskInput(value: unknown): TaskInput | null {
  if (hasRetiredTaskDate(value)) return null;
  const decoded = decodeUnknownResult(TaskInputBodySchema, value);
  if (!decoded.ok) return null;
  const input = decoded.value;
  try {
    return normalizeTaskInput({
      title: input.title,
      notes: nullableString(input.notes),
      dueAt: nullableString(input.dueAt),
      priority: parsePriority(input.priority),
      durationMinutes: nullableInteger(input.durationMinutes),
      links: parseLinks(input.links),
      multiSession: typeof input.multiSession === "boolean" ? input.multiSession : undefined,
      source: typeof input.source === "string" ? input.source : undefined,
    });
  } catch {
    return null;
  }
}

export function parseTaskPatch(value: unknown): TaskPatch | null {
  const decoded = decodeUnknownResult(TaskJsonObjectSchema, value);
  if (!decoded.ok) return null;
  const input = decoded.value;
  try {
    const patch: TaskPatch = {};
    if ("title" in input) {
      if (typeof input.title !== "string") return null;
      patch.title = input.title;
    }
    if ("notes" in input) patch.notes = nullableString(input.notes);
    if ("dueAt" in input) patch.dueAt = nullableString(input.dueAt);
    if ("date" in input) return null;
    if ("priority" in input) patch.priority = parsePriority(input.priority);
    if ("durationMinutes" in input) patch.durationMinutes = nullableInteger(input.durationMinutes);
    if ("links" in input) patch.links = parseLinks(input.links);
    if ("multiSession" in input) {
      if (typeof input.multiSession !== "boolean") return null;
      patch.multiSession = input.multiSession;
    }
    if ("completedAt" in input) patch.completedAt = nullableString(input.completedAt);
    if ("status" in input) {
      if (input.status !== "open" && input.status !== "completed" && input.status !== "archived") return null;
      patch.status = input.status;
    }
    return normalizeTaskPatch(patch);
  } catch {
    return null;
  }
}

function normalizeTaskInput(input: TaskInput): Required<Pick<TaskInput, "title" | "source">> & Omit<TaskInput, "title" | "source"> {
  const title = input.title.trim();
  if (!title) throw new Error("title is required");
  return {
    title,
    notes: cleanNullable(input.notes),
    dueAt: cleanDate(input.dueAt),
    priority: input.priority ?? "normal",
    durationMinutes: cleanDuration(input.durationMinutes),
    links: input.links ?? [],
    multiSession: input.multiSession ?? false,
    source: cleanOptional(input.source) ?? "manual",
  };
}

function normalizeTaskPatch(patch: TaskPatch): TaskPatch {
  const normalized: TaskPatch = { ...patch };
  if (normalized.title !== undefined) {
    normalized.title = normalized.title.trim();
    if (!normalized.title) throw new Error("title is required");
  }
  if ("notes" in normalized) normalized.notes = cleanNullable(normalized.notes);
  if ("dueAt" in normalized) normalized.dueAt = cleanDate(normalized.dueAt);
  if ("completedAt" in normalized) normalized.completedAt = cleanDate(normalized.completedAt);
  if ("durationMinutes" in normalized) normalized.durationMinutes = cleanDuration(normalized.durationMinutes);
  if ("links" in normalized) normalized.links = normalized.links ?? [];
  return normalized;
}

function parsePriority(value: unknown): TaskPriority | undefined {
  const decoded = decodeUnknownResult(TaskPrioritySchema, value);
  return decoded.ok ? decoded.value : undefined;
}

function hasRetiredTaskDate(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "date" in value
  );
}

function parseLinks(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("links must be an array");
  return Array.from(new Set(value.map((link) => {
    if (typeof link !== "string") throw new Error("links must be strings");
    return link.trim();
  }).filter(Boolean)));
}

function parseStoredLinks(value: string | null): string[] {
  if (!value) return [];
  try {
    return [...decodeUnknown(StoredTaskLinksSchema, value)];
  } catch {
    return [];
  }
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function nullableInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function cleanOptional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean ? clean : undefined;
}

function cleanNullable(value: string | null | undefined): string | null {
  return cleanOptional(value ?? undefined) ?? null;
}

function cleanDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return normalizeDate(value, "date");
}

function normalizeDate(value: string, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date.toISOString();
}

function cleanDuration(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) throw new Error("durationMinutes must be a positive integer");
  return value;
}

function normalizeTaskStatus(value: string): TaskStatus {
  const decoded = decodeUnknownResult(TaskStatusSchema, value);
  return decoded.ok ? decoded.value : "open";
}

function normalizeSessionStatus(value: string): TaskSession["status"] {
  if (value === "completed" || value === "cancelled") return value;
  return "planned";
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: normalizeTaskStatus(row.status),
    priority: parsePriority(row.priority) ?? null,
    dueAt: row.due_at,
    source: row.source,
    sourceId: row.source_id,
    durationMinutes: row.duration_minutes,
    links: parseStoredLinks(row.links_json),
    multiSession: row.multi_session === 1,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTaskSession(row: TaskSessionRow): TaskSession {
  return {
    id: row.id,
    taskId: row.task_id,
    startAt: row.start_at,
    endAt: row.end_at,
    status: normalizeSessionStatus(row.status),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
