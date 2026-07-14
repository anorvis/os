import type { LocalAuthorityConfig } from "../../core/config/local-authority";
import { json } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";

export function osRoutes(input: { config: LocalAuthorityConfig; serviceIds: () => string[] }): RouteRegistrar {
  return (route) => {
    route.get("/v1/os/status", () => json({
      ok: true,
      authority: input.config,
      services: input.serviceIds(),
    }));
  };
}
