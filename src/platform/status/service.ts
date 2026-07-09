import type { ServiceContext, ServiceDefinition } from "../../core/service/service";
import { osRoutes } from "./route";

type OsServiceContext = ServiceContext & { serviceIds?: () => string[] };

export function createOsService(context: ServiceContext): ServiceDefinition {
  const osContext = context as OsServiceContext;
  return {
    id: "os",
    routes: [osRoutes({ config: context.config, serviceIds: () => osContext.serviceIds?.() ?? [] })],
    status: () => ({ id: "os", ok: true }),
  };
}
