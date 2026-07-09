import type { ServiceDefinition } from "../../../core/service/service";
import { lifeRoutes } from "./route";

export function createLifeService(): ServiceDefinition {
  return { id: "life", routes: [lifeRoutes()] };
}
