import { json } from "../../../core/http/http";
import type { RouteRegistrar } from "../../../core/service/service";
import { getLifeSnapshot } from "./data";

export function lifeRoutes(): RouteRegistrar {
  return (route) => {
    route.get("/v1/life/snapshot", () => json(getLifeSnapshot()));
  };
}
