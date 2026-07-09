import type { ServiceDefinition } from "../../../core/service/service";
import { webFinanceRoutes } from "./route";

export function createWebFinanceService(): ServiceDefinition {
  return { id: "web-finance", routes: [webFinanceRoutes()] };
}
