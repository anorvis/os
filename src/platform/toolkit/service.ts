import type { ServiceDefinition } from "../../core/service/service";
import { toolkitRoutes } from "./route";

export function createToolkitService(): ServiceDefinition {
  return {
    id: "toolkit",
    routes: [toolkitRoutes()],
    status: () => ({ id: "toolkit", ok: true }),
  };
}
