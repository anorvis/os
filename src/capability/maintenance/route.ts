import { json } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import { getMaintenanceOverview, type MaintenanceOptions } from ".";

export type MaintenanceRouteOptions = Pick<MaintenanceOptions, "root" | "sessionRoots"> & {
  now?: () => Date;
};

export function maintenanceRoutes(options: MaintenanceRouteOptions = {}): RouteRegistrar {
  return (app) => {
    app.get("/v1/maintenance/overview", () => json(getMaintenanceOverview({
      root: options.root,
      sessionRoots: options.sessionRoots,
      now: options.now,
    })));
  };
}
