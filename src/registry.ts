import { createCalendarService } from "./capability/calendar/service";
import { createFinanceService } from "./capability/finance/service";
import { createHealthService } from "./capability/health/service";
import { createIntegrationsService } from "./capability/integration/service";
import { createTasksService } from "./capability/task/service";
import { createLlmWikiService } from "./capability/wiki/service";
import type { ServiceFactory } from "./core/service/service";
import { createEventsService } from "./platform/events/service";
import { createOsService } from "./platform/status/service";
import { createWebFinanceService } from "./product/web/finance/service";
import { createWebHealthService } from "./product/web/health/service";
import { createLifeService } from "./product/web/life/service";
import { createOverviewService } from "./product/web/overview/service";

export const serviceFactories: ServiceFactory[] = [
  createLlmWikiService,
  createEventsService,
  createOverviewService,
  createIntegrationsService,
  createHealthService,
  createWebHealthService,
  createFinanceService,
  createWebFinanceService,
  createTasksService,
  createCalendarService,
  createLifeService,
  createOsService,
];
