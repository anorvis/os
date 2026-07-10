import type { ServiceDefinition } from "../../core/service/service";
import { lifeTagRoutes } from "./route";

export function createLifeTagsService(): ServiceDefinition {
  return { id: "life-tags", routes: [lifeTagRoutes()] };
}
