import type { ToolkitTool } from "./schema";

const tools = [] satisfies ToolkitTool[];

export function toolkitManifest(): { version: number; tools: ToolkitTool[] } {
  return { version: 1, tools };
}
