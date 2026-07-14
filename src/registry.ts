import { createLlmWikiService } from "./capability/wiki/service";
import type { ServiceFactory } from "./core/service/service";
import { createOsService } from "./platform/status/service";
import { createToolkitService } from "./platform/toolkit/service";

export const serviceFactories: ServiceFactory[] = [
  createLlmWikiService,
  createToolkitService,
  createOsService,
];
