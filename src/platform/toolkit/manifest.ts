import { calendarToolkitTools } from "../../capability/calendar/toolkit";
import { financeToolkitTools } from "../../capability/finance/toolkit";
import { taskToolkitTools } from "../../capability/task/toolkit";
import { lifeToolkitTools } from "../../product/web/life/toolkit";
import type { ToolkitTool } from "./schema";

const tools = [
  ...taskToolkitTools,
  ...calendarToolkitTools,
  ...financeToolkitTools,
  ...lifeToolkitTools,
] satisfies ToolkitTool[];

export function toolkitManifest(): { version: number; tools: ToolkitTool[] } {
  return { version: 1, tools };
}
