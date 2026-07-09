import type { ServiceDefinition } from "../../../core/service/service";
import { webHealthRoutes } from "./route";

export function createWebHealthService(): ServiceDefinition {
  return { id: "web-health", routes: [webHealthRoutes()] };
}
