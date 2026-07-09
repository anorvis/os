import { emitInvalidation } from "../../core/events/events";
import { json, parseJsonRequest, validDateParam } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import { createCalendarEvent, deleteCalendarEvent, listCalendarEvents, parseCalendarEventInput, parseCalendarEventPatch, updateCalendarEvent } from "./data";
import { listGoogleCalendarEvents } from "../integration/google";

export function calendarRoutes(): RouteRegistrar {
  return (route) => {
    route.get("/v1/calendar/events", async (c) => {
      const url = new URL(c.req.url);
      const params = {
        timeMin: validDateParam(url.searchParams.get("timeMin")),
        timeMax: validDateParam(url.searchParams.get("timeMax")),
        includeProviders: url.searchParams.get("includeProviders") === "false" ? false : undefined,
      };
      const events = listCalendarEvents(params);
      const googleEvents =
        params.includeProviders === false
          ? []
          : await listGoogleCalendarEvents({
              timeMin: params.timeMin,
              timeMax: params.timeMax,
              maxResults: url.searchParams.get("maxResults") ?? undefined,
            })
              .then((payload) => payload.events.flatMap(googleEventToCalendarEvent))
              .catch(() => []);
      const items = [...events, ...googleEvents].sort((a, b) => a.startAt.localeCompare(b.startAt));
      return json({ events: items, items });
    });

    route.post("/v1/calendar/events", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseCalendarEventInput(parsed.value);
      if (!input) return json({ error: "summary, startAt, and endAt are required" }, 400);
      const event = createCalendarEvent(input);
      emitInvalidation({ type: "calendar.changed", entityId: event.id, domain: "life" });
      return json(event, 201);
    });

    route.patch("/v1/calendar/events/:id", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const patch = parseCalendarEventPatch(parsed.value);
      if (!patch) return json({ error: "invalid calendar event patch" }, 400);
      try {
        const event = updateCalendarEvent(c.req.param("id"), patch);
        if (!event) return json({ error: "event not found" }, 404);
        emitInvalidation({ type: "calendar.changed", entityId: event.id, domain: "life" });
        return json(event);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid calendar event patch" }, 400);
      }
    });

    route.delete("/v1/calendar/events/:id", (c) => {
      const id = c.req.param("id");
      try {
        const deleted = deleteCalendarEvent(id);
        if (deleted) emitInvalidation({ type: "calendar.changed", entityId: id, domain: "life" });
        return deleted ? json({ ok: true }) : json({ error: "event not found" }, 404);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid calendar event" }, 400);
      }
    });
  };
}

type GoogleCalendarApiEvent = {
  id?: string;
  calendarId?: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
};

function googleEventToCalendarEvent(event: GoogleCalendarApiEvent) {
  if (event.status === "cancelled") return [];
  const startRaw = event.start?.dateTime ?? event.start?.date;
  const endRaw = event.end?.dateTime ?? event.end?.date ?? startRaw;
  if (!startRaw || !endRaw) return [];
  const allDay = Boolean(event.start?.date && !event.start?.dateTime);
  const start = allDay ? parseGoogleDate(startRaw) : new Date(startRaw);
  const end = allDay ? parseGoogleDate(endRaw) : new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  return [{
    id: `google:${event.calendarId ?? "primary"}:${event.id ?? start.toISOString()}`,
    summary: event.summary || "untitled event",
    startAt: start.toISOString(),
    endAt: end > start ? end.toISOString() : new Date(start.getTime() + 30 * 60_000).toISOString(),
    tag: "google calendar",
    source: "google-calendar",
    readOnly: true,
    calendarId: event.calendarId ?? "primary",
    providerEventId: event.id ?? null,
    allDay,
    timezone: event.start?.timeZone ?? event.end?.timeZone ?? null,
    createdAt: start.toISOString(),
    updatedAt: start.toISOString(),
  }];
}

function parseGoogleDate(value: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return new Date(value);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}
