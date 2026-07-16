import type { ServiceContext, ServiceDefinition } from "../../core/service/service";
import { maintenanceRoutes, type MaintenanceRouteOptions } from "./route";

type MaintenanceServiceContext = ServiceContext & MaintenanceRouteOptions;

export function createMaintenanceService(context: ServiceContext): ServiceDefinition {
  const options = context as MaintenanceServiceContext;
  return {
    id: "maintenance",
    routes: [maintenanceRoutes({
      root: options.root,
      sessionRoots: options.sessionRoots,
      now: () => context.now(),
    })],
  };
}
