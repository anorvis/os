import { JSONSchema, type Schema } from "effect";

export type ToolkitMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ToolkitOperation =
  "read" | "create" | "update" | "complete" | "delete" | "start" | "stop";
export type ToolkitResource =
  | "task"
  | "calendar_event"
  | "task_session"
  | "life_snapshot"
  | "finance_dashboard"
  | "finance_account"
  | "finance_import"
  | "health_dashboard"
  | "meal"
  | "macro_profile"
  | "workout"
  | "body_measurement"
  | "recipe"
  | "recipe_import"
  | "recipe_search"
  | "food_search"
  | "hevy_settings"
  | "hevy_sync"
  | "hevy_routine"
  | "hevy_exercise_template";

export type ToolkitTool = {
  id: string;
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  domain: string;
  operation: ToolkitOperation;
  resource: ToolkitResource;
  mutates: boolean;
  method: ToolkitMethod;
  path: string;
  pathParams?: string[];
  queryParams?: string[];
  parameters: Record<string, unknown>;
};

export function parametersFromSchema<A, I, R>(
  schema: Schema.Schema<A, I, R>,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = { ...JSONSchema.make(schema) };
  delete parameters.$schema;
  return parameters;
}
