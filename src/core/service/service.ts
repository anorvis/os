import type { Hono } from "hono";
import type { LocalAuthorityConfig } from "../config/local-authority";

export type ServiceContext = {
  config: LocalAuthorityConfig;
  now(): Date;
};

export type RouteRegistrar = (app: Hono) => void;

export type ServiceDefinition = {
  id: string;
  routes: RouteRegistrar[];
  status?: () => Record<string, unknown>;
};

export type ServiceFactory = (context: ServiceContext) => ServiceDefinition;

export function createServiceRegistry(
  context: ServiceContext,
  factories: ServiceFactory[],
): {
  services: ServiceDefinition[];
  routes: RouteRegistrar[];
  serviceIds: string[];
  status(): Record<string, unknown>[];
} {
  const seen = new Set<string>();
  const services = factories.map((factory) => {
    const service = factory(context);
    if (seen.has(service.id)) throw new Error(`duplicate_service_id:${service.id}`);
    seen.add(service.id);
    return service;
  });
  return {
    services,
    routes: services.flatMap((service) => service.routes),
    serviceIds: services.map((service) => service.id),
    status: () => services.flatMap((service) => service.status ? [service.status()] : []),
  };
}
