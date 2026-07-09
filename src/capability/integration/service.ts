import type { ServiceDefinition } from "../../core/service/service";
import { integrationRoutes } from "./route";

export function createIntegrationsService(): ServiceDefinition {
  return { id: "integrations", routes: [integrationRoutes()] };
}
