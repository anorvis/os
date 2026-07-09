import type { ServiceDefinition } from "../../core/service/service";
import { healthRoutes } from "./route";

export function createHealthService(): ServiceDefinition {
  return { id: "health", routes: [healthRoutes()] };
}
