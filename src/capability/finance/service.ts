import type { ServiceDefinition } from "../../core/service/service";
import { financeRoutes } from "./route";

export function createFinanceService(): ServiceDefinition {
  return { id: "finance", routes: [financeRoutes()] };
}
