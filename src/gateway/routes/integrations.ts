import { disconnectHevy, emitInvalidation, getHevySettings, listIntegrations, parseHevySettings, saveHevySettings, syncHevy } from "../../data";
import { json, parseJsonRequest, type RouteHandler } from "../http";

export function integrationRoutes(): RouteHandler {
  return async (request, url) => {
    if (request.method === "GET" && url.pathname === "/v1/integrations") return json(listIntegrations());
    if (request.method === "GET" && url.pathname === "/v1/integrations/hevy/settings") return json(getHevySettings());
    if (request.method === "POST" && url.pathname === "/v1/integrations/hevy/settings") {
      const parsed = await parseJsonRequest(request);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseHevySettings(parsed.value);
      if (!input) return json({ error: "apiKey is required" }, 400);
      const settings = saveHevySettings(input);
      emitInvalidation({ type: "integration.changed", entityId: "hevy", domain: "integration" });
      return json(settings);
    }
    if (request.method === "POST" && url.pathname === "/v1/integrations/hevy/disconnect") {
      const result = disconnectHevy();
      emitInvalidation({ type: "integration.changed", entityId: "hevy", domain: "integration" });
      return json(result);
    }
    if (request.method === "POST" && url.pathname === "/v1/integrations/hevy/sync") {
      const summary = syncHevy();
      if (!summary.ok) return json(summary, 403);
      emitInvalidation({ type: "health.changed", entityId: "hevy", domain: "health" });
      return json({ fetched: summary.fetched, created: summary.created, updated: summary.updated });
    }
    return undefined;
  };
}
