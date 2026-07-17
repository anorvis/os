import type { ServiceContext, ServiceDefinition } from "../../core/service/service";
import { maintenanceRoutes, type MaintenanceRouteOptions } from "../maintenance/route";
import { maintainerRoutes, type MaintainerRouteOptions } from "./route";

type MaintainerServiceContext = ServiceContext & MaintainerRouteOptions & MaintenanceRouteOptions & {
  maintenanceRoot?: string;
  maintenanceSessionRoots?: MaintenanceRouteOptions["sessionRoots"];
};

export function createMaintainerService(context: ServiceContext): ServiceDefinition {
  const options = context as MaintainerServiceContext;
  return {
    id: "maintainer",
    routes: [
      maintainerRoutes({
        env: options.env,
        sandboxDir: options.sandboxDir,
        commandRunner: options.commandRunner,
        fetch: options.fetch,
        tempDirectory: options.tempDirectory,
        platform: options.platform,
        vaultLoginLauncher: options.vaultLoginLauncher,
      }),
      maintenanceRoutes({
        root: options.maintenanceRoot ?? options.root,
        sessionRoots: options.maintenanceSessionRoots ?? options.sessionRoots,
        maintainerModelPerfPath: options.maintainerModelPerfPath,
        foregroundStatsPath: options.foregroundStatsPath,
        now: () => context.now(),
      }),
    ],
  };
}
