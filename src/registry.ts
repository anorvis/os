import { createMaintainerService } from "./capability/maintainer/service";
import { createContextService } from "./capability/context/service";
import { createLlmWikiService } from "./capability/wiki/service";
import type { ServiceFactory } from "./core/service/service";
import { createOsService } from "./platform/status/service";

export const serviceFactories: ServiceFactory[] = [
  createLlmWikiService,
  createContextService,
  createMaintainerService,
  createOsService,
];
