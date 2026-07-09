import { json } from "../../../core/http/http";
import type { RouteRegistrar } from "../../../core/service/service";
import { getHealthDashboard } from "../../../capability/health/data";

export function webHealthRoutes(): RouteRegistrar {
  return (route) => {
    route.get("/v1/health/dashboard", () => json(getHealthDashboard()));
  };
}
