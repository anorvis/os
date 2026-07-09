import type { ServiceDefinition } from "../../core/service/service";
import { taskRoutes } from "./route";

export function createTasksService(): ServiceDefinition {
  return { id: "tasks", routes: [taskRoutes()] };
}
