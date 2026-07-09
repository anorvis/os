import { Schema } from "effect";

export const CalendarEventBodySchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const CalendarEventInputBodySchema = Schema.Struct({
  summary: Schema.String,
  startAt: Schema.optional(Schema.Unknown),
  endAt: Schema.optional(Schema.Unknown),
  location: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.Unknown),
  tag: Schema.optional(Schema.Unknown),
  calendarId: Schema.optional(Schema.Unknown),
  allDay: Schema.optional(Schema.Unknown),
  timezone: Schema.optional(Schema.Unknown),
});
