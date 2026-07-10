import { JSONSchema, type Schema } from "effect";

export type ToolkitMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type ToolkitOperation =
  "read" | "create" | "update" | "complete" | "delete" | "start" | "stop";
export type ToolkitResource =
  | "task"
  | "calendar_event"
  | "task_session"
  | "life_snapshot"
  | "finance_dashboard"
  | "finance_account"
  | "finance_import";

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
