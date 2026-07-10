import { Schema } from "effect";

export const LifeTagCreateBodySchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.Unknown),
});

export const LifeTagUpdateBodySchema = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  color: Schema.optional(Schema.Unknown),
  hidden: Schema.optional(Schema.Unknown),
});
