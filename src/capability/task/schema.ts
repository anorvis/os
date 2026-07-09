import { Schema } from "effect";

export const TaskPrioritySchema = Schema.Literal("low", "normal", "high", "urgent");
export const TaskStatusSchema = Schema.Literal("open", "completed", "archived");
export const TaskJsonObjectSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const TaskInputBodySchema = Schema.Struct({
  title: Schema.String,
  notes: Schema.optional(Schema.Unknown),
  dueAt: Schema.optional(Schema.Unknown),
  priority: Schema.optional(Schema.Unknown),
  durationMinutes: Schema.optional(Schema.Unknown),
  links: Schema.optional(Schema.Unknown),
  multiSession: Schema.optional(Schema.Unknown),
  source: Schema.optional(Schema.Unknown),
});

export const TaskSessionInputSchema = Schema.Struct({
  startAt: Schema.String,
  endAt: Schema.String,
});

export const StoredTaskLinksSchema = Schema.parseJson(Schema.Array(Schema.String));

export type TaskPriority = typeof TaskPrioritySchema.Type;
export type TaskStatus = typeof TaskStatusSchema.Type;
export type TaskInputBody = typeof TaskInputBodySchema.Type;
export type TaskSessionInput = typeof TaskSessionInputSchema.Type;
