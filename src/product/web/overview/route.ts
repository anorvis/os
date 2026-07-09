import { json } from "../../../core/http/http";
import type { RouteRegistrar } from "../../../core/service/service";
import { getOverview } from "./data";

export function overviewRoutes(): RouteRegistrar {
  return (route) => {
    route.get("/v1/overview", () => json(getOverview()));
  };
}
