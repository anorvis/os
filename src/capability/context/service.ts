import type { ServiceContext, ServiceDefinition } from "../../core/service/service";
import { contextRoutes, type ContextRouteOptions } from "./route";

export type ContextServiceContext = ServiceContext & ContextRouteOptions;

export function createContextService(context: ServiceContext): ServiceDefinition {
  const options = context as ContextServiceContext;
  return {
    id: "context",
    routes: [contextRoutes({ contextClient: options.contextClient })],
  };
}
