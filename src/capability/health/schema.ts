import { Schema } from "effect";

export const HealthJsonObjectSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export const HealthStringArrayJsonSchema = Schema.parseJson(Schema.Array(Schema.String));

export const MealInputBodySchema = Schema.Struct({
  name: Schema.String,
  mealType: Schema.String,
  loggedAt: Schema.String,
  calories: Schema.optional(Schema.Unknown),
  proteinGrams: Schema.optional(Schema.Unknown),
  carbsGrams: Schema.optional(Schema.Unknown),
  fatGrams: Schema.optional(Schema.Unknown),
  source: Schema.optional(Schema.Unknown),
  notes: Schema.optional(Schema.Unknown),
});

export const WorkoutInputBodySchema = Schema.Struct({
  title: Schema.String,
  startedAt: Schema.String,
  durationSeconds: Schema.optional(Schema.Unknown),
  notes: Schema.optional(Schema.Unknown),
  source: Schema.optional(Schema.Unknown),
  exercises: Schema.optional(Schema.Unknown),
});
