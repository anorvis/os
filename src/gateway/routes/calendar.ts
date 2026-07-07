import { createCalendarEvent, deleteCalendarEvent, emitInvalidation, listCalendarEvents, parseCalendarEventInput, parseCalendarEventPatch, updateCalendarEvent } from "../../data";
import { json, parseJsonRequest, validDateParam, type RouteHandler } from "../http";

export function calendarRoutes(): RouteHandler {
  return async (request, url) => {
    if (request.method === "GET" && url.pathname === "/v1/calendar/events") {
      const events = listCalendarEvents({
        timeMin: validDateParam(url.searchParams.get("timeMin")),
        timeMax: validDateParam(url.searchParams.get("timeMax")),
        includeProviders: url.searchParams.get("includeProviders") === "false" ? false : undefined,
      });
      return json({ events, items: events });
    }
    if (request.method === "POST" && url.pathname === "/v1/calendar/events") {
      const parsed = await parseJsonRequest(request);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseCalendarEventInput(parsed.value);
      if (!input) return json({ error: "summary, startAt, and endAt are required" }, 400);
      const event = createCalendarEvent(input);
      emitInvalidation({ type: "calendar.changed", entityId: event.id, domain: "life" });
      return json(event, 201);
    }
    const calendarEventMatch = url.pathname.match(/^\/v1\/calendar\/events\/([^/]+)$/);
    if (calendarEventMatch?.[1] && request.method === "PATCH") {
      const parsed = await parseJsonRequest(request);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const patch = parseCalendarEventPatch(parsed.value);
      if (!patch) return json({ error: "invalid calendar event patch" }, 400);
      try {
        const event = updateCalendarEvent(decodeURIComponent(calendarEventMatch[1]), patch);
        if (!event) return json({ error: "event not found" }, 404);
        emitInvalidation({ type: "calendar.changed", entityId: event.id, domain: "life" });
        return json(event);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid calendar event patch" }, 400);
      }
    }
    if (calendarEventMatch?.[1] && request.method === "DELETE") {
      try {
        const deleted = deleteCalendarEvent(decodeURIComponent(calendarEventMatch[1]));
        if (deleted) emitInvalidation({ type: "calendar.changed", entityId: decodeURIComponent(calendarEventMatch[1]), domain: "life" });
        return deleted ? json({ ok: true }) : json({ error: "event not found" }, 404);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid calendar event" }, 400);
      }
    }
    return undefined;
  };
}
