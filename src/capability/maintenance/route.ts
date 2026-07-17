import { json } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import {
  type MaintenanceOptions,
  type MaintenanceTicketStatus,
  type MaintenanceUsageScope,
} from ".";
import { getMaintenanceOverview } from "./overview";

export type MaintenanceRouteOptions = Pick<
  MaintenanceOptions,
  "root" | "sessionRoots" | "maintainerModelPerfPath" | "foregroundStatsPath"
> & {
  now?: () => Date;
};

export function maintenanceRoutes(options: MaintenanceRouteOptions = {}): RouteRegistrar {
  return (app) => {
    app.get("/v1/maintainer/overview", (context) => {
      const url = new URL(context.req.url);
      const requestedScope = url.searchParams.get("sessionScope");
      if (requestedScope !== null && requestedScope !== "foreground" && requestedScope !== "maintainer") {
        return json({ error: "sessionScope must be foreground or maintainer" }, 400);
      }
      const sessionScope: MaintenanceUsageScope = requestedScope === "maintainer" ? "maintainer" : "foreground";
      const hasPagination = url.searchParams.has("limit") || url.searchParams.has("offset") || url.searchParams.has("status");
      const hasSessionPagination = url.searchParams.has("sessionLimit") || url.searchParams.has("sessionOffset");
      const statuses = url.searchParams.get("status")?.split(",").map((status) => status.trim()).filter(Boolean) as
        | MaintenanceTicketStatus[]
        | undefined;
      // A ticket pagination request without a session view never renders
      // usage; skip the session-root scan and performance load entirely.
      const ticketsOnly = hasPagination && !hasSessionPagination;
      return json(getMaintenanceOverview({
        root: options.root,
        sessionRoots: options.sessionRoots,
        maintainerModelPerfPath: options.maintainerModelPerfPath,
        foregroundStatsPath: options.foregroundStatsPath,
        sessionScope,
        now: options.now,
        includeUsage: !ticketsOnly,
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
