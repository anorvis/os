import type { ServiceDefinition } from "../../core/service/service";
import { eventRoutes } from "./route";

export function createEventsService(): ServiceDefinition {
  return { id: "events", routes: [eventRoutes()] };
}
