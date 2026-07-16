import type { ServiceContext, ServiceDefinition } from "../../core/service/service";
import { maintainerRoutes, type MaintainerRouteOptions } from "./route";

type MaintainerServiceContext = ServiceContext & MaintainerRouteOptions;

export function createMaintainerService(context: ServiceContext): ServiceDefinition {
  const options = context as MaintainerServiceContext;
  return {
    id: "maintainer",
    routes: [maintainerRoutes({
      env: options.env,
      sandboxDir: options.sandboxDir,
      commandRunner: options.commandRunner,
      fetch: options.fetch,
      tempDirectory: options.tempDirectory,
      platform: options.platform,
      vaultLoginLauncher: options.vaultLoginLauncher,
    })],
  };
}
