import { randomUUID } from "node:crypto";
import { decodeUnknownResult } from "../../core/effect/schema";
import { getDatabase } from "../../core/db/database";
import { CalendarEventBodySchema, CalendarEventInputBodySchema } from "./schema";

export type CalendarEvent = {
  id: string;
  summary: string;
  startAt: string;
  endAt: string;
  location?: string;
  description?: string;
  tag?: string | null;
  source: string;
  readOnly: boolean;
  calendarId?: string | null;
  providerEventId?: string | null;
  allDay?: boolean;
  timezone?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CalendarEventInput = {
  summary: string;
  startAt: string;
  endAt: string;
  location?: string;
  description?: string;
  tag?: string;
  calendarId?: string | null;
  allDay?: boolean;
  timezone?: string | null;
};

export type CalendarEventPatch = Partial<CalendarEventInput>;

type CalendarEventRow = {
  id: string;
  summary: string;
  start_at: string;
  end_at: string;
  location: string | null;
  description: string | null;
  tag: string | null;
  source: string;
  read_only: number;
  provider_event_id: string | null;
  calendar_id: string | null;
  all_day: number;
  timezone: string | null;
  created_at: string;
  updated_at: string;
};

type ListEventsParams = {
  timeMin?: string;
  timeMax?: string;
  includeProviders?: boolean;
};

export function listCalendarEvents(input: ListEventsParams = {}): CalendarEvent[] {
  const providerClause = input.includeProviders === false ? "AND source = 'local'" : "";
  const rows = getDatabase().query<CalendarEventRow, [string | null, string | null]>(`
    SELECT id, summary, start_at, end_at, location, description, tag, source, read_only, provider_event_id, calendar_id, all_day, timezone, created_at, updated_at
    FROM calendar_events
    WHERE (?1 IS NULL OR end_at >= ?1)
      AND (?2 IS NULL OR start_at <= ?2)
      ${providerClause}
    ORDER BY start_at ASC, created_at ASC
  `).all(input.timeMin ?? null, input.timeMax ?? null);
  return rows.map(rowToEvent);
}

export function createCalendarEvent(input: CalendarEventInput, now = new Date()): CalendarEvent {
  const event = normalizeInput(input);
  const timestamp = now.toISOString();
  const id = randomUUID();
  getDatabase().query(`
    INSERT INTO calendar_events (id, provider, summary, start_at, end_at, location, description, tag, source, read_only, calendar_id, all_day, timezone, created_at, updated_at)
    VALUES (?1, 'local', ?2, ?3, ?4, ?5, ?6, ?7, 'local', 0, ?8, ?9, ?10, ?11, ?11)
  `).run(id, event.summary, event.startAt, event.endAt, event.location ?? null, event.description ?? null, event.tag ?? null, event.calendarId ?? null, event.allDay ? 1 : 0, event.timezone ?? null, timestamp);
  const created = getCalendarEvent(id);
  if (!created) throw new Error("Created calendar event could not be read.");
  return created;
}

export function getCalendarEvent(id: string): CalendarEvent | null {
  const row = getDatabase().query<CalendarEventRow, [string]>(`
    SELECT id, summary, start_at, end_at, location, description, tag, source, read_only, provider_event_id, calendar_id, all_day, timezone, created_at, updated_at
    FROM calendar_events
    WHERE id = ?1
  `).get(id);
  return row ? rowToEvent(row) : null;
}

export function updateCalendarEvent(id: string, patch: CalendarEventPatch, now = new Date()): CalendarEvent | null {
  const existing = getCalendarEvent(id);
  if (!existing) return null;
  if (existing.readOnly) throw new Error("read-only calendar events cannot be updated");
  const normalizedPatch = normalizePatch(patch);
  const next = {
    summary: normalizedPatch.summary ?? existing.summary,
    startAt: normalizedPatch.startAt ?? existing.startAt,
    endAt: normalizedPatch.endAt ?? existing.endAt,
    location: Object.prototype.hasOwnProperty.call(normalizedPatch, "location") ? normalizedPatch.location ?? null : existing.location ?? null,
    description: Object.prototype.hasOwnProperty.call(normalizedPatch, "description") ? normalizedPatch.description ?? null : existing.description ?? null,
    tag: Object.prototype.hasOwnProperty.call(normalizedPatch, "tag") ? normalizedPatch.tag ?? null : existing.tag ?? null,
    calendarId: Object.prototype.hasOwnProperty.call(normalizedPatch, "calendarId") ? normalizedPatch.calendarId ?? null : existing.calendarId ?? null,
    allDay: Object.prototype.hasOwnProperty.call(normalizedPatch, "allDay") ? normalizedPatch.allDay === true : existing.allDay === true,
    timezone: Object.prototype.hasOwnProperty.call(normalizedPatch, "timezone") ? normalizedPatch.timezone ?? null : existing.timezone ?? null,
  };
  if (new Date(next.endAt).getTime() <= new Date(next.startAt).getTime()) throw new Error("endAt must be after startAt");
  getDatabase().query(`
    UPDATE calendar_events
    SET summary = ?2, start_at = ?3, end_at = ?4, location = ?5, description = ?6, tag = ?7, calendar_id = ?8, all_day = ?9, timezone = ?10, updated_at = ?11
    WHERE id = ?1
  `).run(id, next.summary, next.startAt, next.endAt, next.location, next.description, next.tag, next.calendarId, next.allDay ? 1 : 0, next.timezone, now.toISOString());
  return getCalendarEvent(id);
}

export function deleteCalendarEvent(id: string): boolean {
  const existing = getCalendarEvent(id);
  if (existing?.readOnly) throw new Error("read-only calendar events cannot be deleted");
  return getDatabase().query("DELETE FROM calendar_events WHERE id = ?1").run(id).changes > 0;
}

export function parseCalendarEventInput(value: unknown): CalendarEventInput | null {
  const decoded = decodeUnknownResult(CalendarEventInputBodySchema, value);
  if (!decoded.ok || hasRetiredCalendarDateTime(value)) return null;
  const input = decoded.value;
  if (typeof input.startAt !== "string" || typeof input.endAt !== "string") return null;
  try {
    return normalizeInput({
      summary: input.summary,
      startAt: input.startAt,
      endAt: input.endAt,
      location: typeof input.location === "string" ? input.location : undefined,
      description: typeof input.description === "string" ? input.description : undefined,
      tag: typeof input.tag === "string" ? input.tag : undefined,
      calendarId: typeof input.calendarId === "string" ? input.calendarId : null,
      allDay: input.allDay === true,
      timezone: typeof input.timezone === "string" ? input.timezone : null,
    });
  } catch {
    return null;
  }
}

export function parseCalendarEventPatch(raw: unknown): CalendarEventPatch | null {
  const decoded = decodeUnknownResult(CalendarEventBodySchema, raw);
  if (!decoded.ok) return null;
  const value = decoded.value;
  const patch: CalendarEventPatch = {};
  if ("summary" in value) {
    if (typeof value.summary !== "string") return null;
    patch.summary = value.summary;
  }
  if ("startDateTime" in value || "endDateTime" in value) return null;
  if ("startAt" in value) {
    if (value.startAt !== undefined && typeof value.startAt !== "string") return null;
    patch.startAt = value.startAt;
  }
  if ("endAt" in value) {
    if (value.endAt !== undefined && typeof value.endAt !== "string") return null;
    patch.endAt = value.endAt;
  }
  if ("location" in value) {
    if (value.location !== undefined && typeof value.location !== "string") return null;
    patch.location = value.location;
  }
  if ("description" in value) {
    if (value.description !== undefined && typeof value.description !== "string") return null;
    patch.description = value.description;
  }
  if ("tag" in value) {
    if (value.tag !== undefined && typeof value.tag !== "string") return null;
    patch.tag = value.tag;
  }
  if ("calendarId" in value) {
    if (value.calendarId !== null && value.calendarId !== undefined && typeof value.calendarId !== "string") return null;
    patch.calendarId = value.calendarId;
  }
  if ("allDay" in value) {
    if (value.allDay !== undefined && typeof value.allDay !== "boolean") return null;
    patch.allDay = value.allDay;
  }
  if ("timezone" in value) {
    if (value.timezone !== null && value.timezone !== undefined && typeof value.timezone !== "string") return null;
    patch.timezone = value.timezone;
  }
  try {
    return normalizePatch(patch);
  } catch {
    return null;
  }
}

function hasRetiredCalendarDateTime(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("startDateTime" in value || "endDateTime" in value)
  );
}

function normalizeInput(input: CalendarEventInput): CalendarEventInput {
  const summary = input.summary.trim();
  if (!summary) throw new Error("summary is required");
  const startAt = normalizeDate(input.startAt, "startAt");
  const endAt = normalizeDate(input.endAt, "endAt");
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) throw new Error("endAt must be after startAt");
  return {
    summary,
    startAt,
    endAt,
    location: cleanOptional(input.location),
    description: cleanOptional(input.description),
    tag: cleanOptional(input.tag),
    calendarId: cleanNullable(input.calendarId),
    allDay: input.allDay === true,
    timezone: cleanNullable(input.timezone),
  };
}

function normalizePatch(patch: CalendarEventPatch): CalendarEventPatch {
  const normalized: CalendarEventPatch = { ...patch };
  if (normalized.summary !== undefined) {
    normalized.summary = normalized.summary.trim();
    if (!normalized.summary) throw new Error("summary is required");
  }
  if (normalized.startAt !== undefined) normalized.startAt = normalizeDate(normalized.startAt, "startAt");
  if (normalized.endAt !== undefined) normalized.endAt = normalizeDate(normalized.endAt, "endAt");
  if (normalized.startAt && normalized.endAt && new Date(normalized.endAt).getTime() <= new Date(normalized.startAt).getTime()) throw new Error("endAt must be after startAt");
  if ("location" in normalized) normalized.location = cleanOptional(normalized.location);
  if ("description" in normalized) normalized.description = cleanOptional(normalized.description);
  if ("tag" in normalized) normalized.tag = cleanOptional(normalized.tag);
  if ("calendarId" in normalized) normalized.calendarId = cleanNullable(normalized.calendarId);
  if ("timezone" in normalized) normalized.timezone = cleanNullable(normalized.timezone);
  return normalized;
}

function normalizeDate(value: string, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date.toISOString();
}

function cleanOptional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean ? clean : undefined;
}

function cleanNullable(value: string | null | undefined): string | null {
  return cleanOptional(value ?? undefined) ?? null;
}

function rowToEvent(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    summary: row.summary,
    startAt: row.start_at,
    endAt: row.end_at,
    location: row.location ?? undefined,
    description: row.description ?? undefined,
    tag: row.tag,
    source: row.source,
    readOnly: row.read_only === 1,
    calendarId: row.calendar_id,
    providerEventId: row.provider_event_id,
    allDay: row.all_day === 1,
    timezone: row.timezone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

