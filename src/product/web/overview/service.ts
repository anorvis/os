import type { ServiceDefinition } from "../../../core/service/service";
import { overviewRoutes } from "./route";

export function createOverviewService(): ServiceDefinition {
  return { id: "overview", routes: [overviewRoutes()] };
}
