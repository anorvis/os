import { json } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import {
  getMaintenanceOverview,
  type MaintenanceOptions,
  type MaintenanceTicketStatus,
} from ".";

export type MaintenanceRouteOptions = Pick<MaintenanceOptions, "root" | "sessionRoots"> & {
  now?: () => Date;
};

export function maintenanceRoutes(options: MaintenanceRouteOptions = {}): RouteRegistrar {
  return (app) => {
    app.get("/v1/maintenance/overview", (context) => {
      const url = new URL(context.req.url);
      const hasPagination = url.searchParams.has("limit") || url.searchParams.has("offset") || url.searchParams.has("status");
      const hasSessionPagination = url.searchParams.has("sessionLimit") || url.searchParams.has("sessionOffset");
      const statuses = url.searchParams.get("status")?.split(",").map((status) => status.trim()).filter(Boolean) as
        | MaintenanceTicketStatus[]
        | undefined;
      return json(getMaintenanceOverview({
        root: options.root,
        sessionRoots: options.sessionRoots,
        now: options.now,
        ...(hasPagination ? { limit: parseBoundedNumber(url.searchParams.get("limit"), 20, 100), offset: parseBoundedNumber(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER) } : {}),
        ...(statuses ? { ticketStatuses: statuses } : {}),
        ...(hasSessionPagination ? {
          sessionLimit: parseBoundedNumber(url.searchParams.get("sessionLimit"), 20, 100),
          sessionOffset: parseBoundedNumber(url.searchParams.get("sessionOffset"), 0, Number.MAX_SAFE_INTEGER),
        } : {}),
      }));
    });
  };
}

function parseBoundedNumber(value: string | null, fallback: number, maximum: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  return Math.min(maximum, Number(value));
}
