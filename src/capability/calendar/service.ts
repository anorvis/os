import type { ServiceDefinition } from "../../core/service/service";
import { calendarRoutes } from "./route";

export function createCalendarService(): ServiceDefinition {
  return { id: "calendar", routes: [calendarRoutes()] };
}
