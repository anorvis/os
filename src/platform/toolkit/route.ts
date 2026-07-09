import { json } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import { toolkitManifest } from "./manifest";

export function toolkitRoutes(): RouteRegistrar {
  return (route) => {
    route.get("/v1/os/toolkit", () => json(toolkitManifest()));
  };
}
