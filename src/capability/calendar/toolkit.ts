import { Schema } from "effect";
import { parametersFromSchema, type ToolkitTool } from "../../platform/toolkit/schema";

const CalendarEventListQuerySchema = Schema.Struct({
  timeMin: Schema.optional(Schema.String.annotations({ description: "Optional ISO start time for the query range." })),
  timeMax: Schema.optional(Schema.String.annotations({ description: "Optional ISO end time for the query range." })),
  includeProviders: Schema.optional(Schema.Boolean.annotations({ description: "Whether provider calendars should be included." })),
  maxResults: Schema.optional(Schema.String.annotations({ description: "Optional provider max results limit." })),
});
const CalendarEventInputSchema = Schema.Struct({
  summary: Schema.String.annotations({ description: "Calendar event title." }),
  startAt: Schema.String.annotations({ description: "ISO timestamp event start time." }),
  endAt: Schema.String.annotations({ description: "ISO timestamp event end time." }),
  location: Schema.optional(Schema.String.annotations({ description: "Optional event location." })),
  description: Schema.optional(Schema.String.annotations({ description: "Optional event description." })),
  tag: Schema.optional(Schema.String.annotations({ description: "Optional source or category tag." })),
  calendarId: Schema.optional(Schema.String.annotations({ description: "Optional calendar id." })),
  allDay: Schema.optional(Schema.Boolean.annotations({ description: "Whether the event is all-day." })),
  timezone: Schema.optional(Schema.String.annotations({ description: "Optional IANA timezone." })),
});
const CalendarEventPatchSchema = Schema.Struct({
  id: Schema.String.annotations({ description: "Calendar event id." }),
  summary: Schema.optional(Schema.String.annotations({ description: "Updated calendar event title." })),
  startAt: Schema.optional(Schema.String.annotations({ description: "Updated ISO timestamp event start time." })),
  endAt: Schema.optional(Schema.String.annotations({ description: "Updated ISO timestamp event end time." })),
  location: Schema.optional(Schema.String.annotations({ description: "Updated event location." })),
  description: Schema.optional(Schema.String.annotations({ description: "Updated event description." })),
  tag: Schema.optional(Schema.String.annotations({ description: "Updated source or category tag." })),
  calendarId: Schema.optional(Schema.String.annotations({ description: "Updated calendar id." })),
  allDay: Schema.optional(Schema.Boolean.annotations({ description: "Whether the event is all-day." })),
  timezone: Schema.optional(Schema.String.annotations({ description: "Updated IANA timezone." })),
});
const CalendarEventIdSchema = Schema.Struct({
  id: Schema.String.annotations({ description: "Calendar event id." }),
});

export const calendarToolkitTools = [
  {
    id: "calendar_event.list",
    name: "anorvis_list_calendar_events",
    label: "List Calendar Events",
    description: "List calendar events in Anorvis OS.",
    domain: "life",
    operation: "read",
    resource: "calendar_event",
    mutates: false,
    method: "GET",
    path: "/v1/calendar/events",
    queryParams: ["timeMin", "timeMax", "includeProviders", "maxResults"],
    parameters: parametersFromSchema(CalendarEventListQuerySchema),
  },
  {
    id: "calendar_event.create",
    name: "anorvis_create_calendar_event",
    label: "Create Calendar Event",
    description: "Create a calendar event in Anorvis OS.",
    domain: "life",
    operation: "create",
    resource: "calendar_event",
    mutates: true,
    method: "POST",
    path: "/v1/calendar/events",
    parameters: parametersFromSchema(CalendarEventInputSchema),
  },
  {
    id: "calendar_event.update",
    name: "anorvis_update_calendar_event",
    label: "Update Calendar Event",
    description: "Update an existing calendar event in Anorvis OS.",
    domain: "life",
    operation: "update",
    resource: "calendar_event",
    mutates: true,
    method: "PATCH",
    path: "/v1/calendar/events/:id",
    pathParams: ["id"],
    parameters: parametersFromSchema(CalendarEventPatchSchema),
  },
  {
    id: "calendar_event.delete",
    name: "anorvis_delete_calendar_event",
    label: "Delete Calendar Event",
    description: "Delete a calendar event from Anorvis OS.",
    domain: "life",
    operation: "delete",
    resource: "calendar_event",
    mutates: true,
    method: "DELETE",
    path: "/v1/calendar/events/:id",
    pathParams: ["id"],
    parameters: parametersFromSchema(CalendarEventIdSchema),
  },
] satisfies ToolkitTool[];
