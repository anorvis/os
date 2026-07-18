import { json, isJsonObject, parseJsonRequest } from "../../core/http/http";
import type { LocalAuthorityConfig } from "../../core/config/local-authority";
import type { RouteRegistrar } from "../../core/service/service";
import {
  createMaintenanceStore,
  type MaintenanceOptions,
  type MaintenanceTicketStatus,
  type MaintenanceUsageScope,
} from ".";
import {
  createLinearAuthorization,
  disconnectLinear,
  getLinearStatus,
  handleLinearCallback,
  listLinearTeams,
  pushLinearTicketState,
  readLinearLinks,
  saveLinearCredentials,
  selectLinearTeam,
  syncLinearTickets,
  type LinearFetch,
} from "./linear";
import { getMaintenanceOverview } from "./overview";
export type MaintenanceRouteOptions = Pick<
  MaintenanceOptions,
  "root" | "sessionRoots" | "maintainerModelPerfPath" | "foregroundStatsPath"
> & {
  now?: () => Date;
  config?: Pick<LocalAuthorityConfig, "bindHost" | "port">;
  fetch?: LinearFetch;
};

export function maintenanceRoutes(options: MaintenanceRouteOptions = {}): RouteRegistrar {
  return (app) => {
    app.get("/v1/maintainer/overview", (context) => {
      const url = new URL(context.req.url);
      const requestedScope = url.searchParams.get("sessionScope");
      if (requestedScope !== null && requestedScope !== "foreground" && requestedScope !== "monitor" && requestedScope !== "maintainer") {
        return json({ error: "sessionScope must be foreground, monitor, or maintainer" }, 400);
      }
      const sessionScope: MaintenanceUsageScope = requestedScope === "maintainer"
        ? "maintainer"
        : requestedScope === "monitor"
          ? "monitor"
          : "foreground";
      const hasPagination = url.searchParams.has("limit") || url.searchParams.has("offset") || url.searchParams.has("status");
      const hasSessionPagination = url.searchParams.has("sessionLimit") || url.searchParams.has("sessionOffset");
      const statuses = url.searchParams.get("status")?.split(",").map((status) => status.trim()).filter(Boolean) as
        | MaintenanceTicketStatus[]
        | undefined;
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

    app.post("/v1/maintenance/tickets/:id/triage", async (context) => {
      const parsed = await parseJsonRequest(context.req.raw);
      if (!parsed.ok || !isJsonObject(parsed.value)) {
        return json({ error: parsed.ok ? "triage body must be an object" : parsed.error }, 400);
      }
      const action = parsed.value.action;
      if (action !== "approve" && action !== "dismiss") {
        return json({ error: "action must be approve or dismiss" }, 400);
      }
      const id = context.req.param("id");
      const store = createMaintenanceStore({ root: options.root, now: options.now });
      const current = store.listTickets().find((ticket) => ticket.id === id);
      if (!current) return json({ error: "not_found" }, 404);
      const valid = action === "approve"
        ? current.status === "pending_approval"
        : current.status === "pending_approval" || current.status === "approved";
      if (!valid) return json({ error: "invalid_status", status: current.status }, 409);
      const status = action === "approve" ? "approved" : "rejected";
      const ticket = store.updateTicket(id, { status });
      if (!ticket) return json({ error: "not_found" }, 404);
      let warning: string | undefined;
      try {
        await pushLinearTicketState(id, action === "approve" ? "unstarted" : "canceled", {
          root: options.root,
          fetch: options.fetch,
          config: options.config,
          now: options.now,
        });
      } catch (error) {
        warning = boundedWarning(error);
      }
      const link = readLinearLinks({ root: options.root })[id];
      return json({
        ticket: link ? { ...ticket, linear: { identifier: link.identifier, url: link.url } } : ticket,
        ...(warning ? { warning } : {}),
      });
    });

    app.get("/v1/maintenance/linear", () => json(getLinearStatus({ root: options.root })));

    app.post("/v1/maintenance/linear/credentials", async (context) => {
      const parsed = await parseJsonRequest(context.req.raw);
      if (!parsed.ok || !isJsonObject(parsed.value)) {
        return json({ error: parsed.ok ? "credentials must be an object" : parsed.error }, 400);
      }
      const values = parsed.value;
      for (const name of ["clientId", "clientSecret", "apiKey"] as const) {
        if (values[name] !== undefined && typeof values[name] !== "string") {
          return json({ error: `${name} must be a string` }, 400);
        }
      }
      try {
        await saveLinearCredentials({
          ...(typeof values.clientId === "string" ? { clientId: values.clientId } : {}),
          ...(typeof values.clientSecret === "string" ? { clientSecret: values.clientSecret } : {}),
          ...(typeof values.apiKey === "string" ? { apiKey: values.apiKey } : {}),
        }, { root: options.root, fetch: options.fetch, config: options.config, now: options.now });
        return json({ ok: true });
      } catch (error) {
        return json({ error: boundedWarning(error) }, 400);
      }
    });

    app.post("/v1/maintenance/linear/authorize", async (context) => {
      const parsed = await parseJsonRequest(context.req.raw);
      if (!parsed.ok || !isJsonObject(parsed.value)) {
        return json({ error: parsed.ok ? "authorize body must be an object" : parsed.error }, 400);
      }
      if (parsed.value.returnTo !== undefined && typeof parsed.value.returnTo !== "string") {
        return json({ error: "returnTo must be a string" }, 400);
      }
      try {
        return json(createLinearAuthorization(
          typeof parsed.value.returnTo === "string" ? { returnTo: parsed.value.returnTo } : {},
          { root: options.root, config: options.config, now: options.now },
        ));
      } catch (error) {
        return json({ error: boundedWarning(error) }, 400);
      }
    });

    app.get("/v1/maintenance/linear/callback", async (context) => {
      const url = new URL(context.req.url);
      const result = await handleLinearCallback({
        code: url.searchParams.get("code") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
      }, { root: options.root, fetch: options.fetch, config: options.config, now: options.now });
      if (result.redirect) return Response.redirect(result.redirect, 302);
      return json({ error: result.error ?? "invalid OAuth callback" }, 400);
    });

    app.get("/v1/maintenance/linear/teams", async () => {
      try {
        return json(await listLinearTeams({ root: options.root, fetch: options.fetch }));
      } catch (error) {
        return json({ error: boundedWarning(error) }, 400);
      }
    });

    app.post("/v1/maintenance/linear/team", async (context) => {
      const parsed = await parseJsonRequest(context.req.raw);
      if (!parsed.ok || !isJsonObject(parsed.value) || typeof parsed.value.teamId !== "string") {
        return json({ error: parsed.ok ? "teamId must be a string" : parsed.error }, 400);
      }
      try {
        return json(await selectLinearTeam(parsed.value.teamId, { root: options.root, fetch: options.fetch }));
      } catch (error) {
        return json({ error: boundedWarning(error) }, 400);
      }
    });

    app.post("/v1/maintenance/linear/disconnect", () => json(disconnectLinear({ root: options.root })));

    app.post("/v1/maintenance/linear/sync", async () => json(await syncLinearTickets({
      root: options.root,
      fetch: options.fetch,
      config: options.config,
      now: options.now,
    })));
  };
}

function parseBoundedNumber(value: string | null, fallback: number, maximum: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  return Math.min(maximum, Number(value));
}

function boundedWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").trim().slice(0, 240) || "Linear request failed";
}
