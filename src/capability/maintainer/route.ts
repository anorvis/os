import { isJsonObject, json, parseJsonRequest } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import {
  getMaintainerStatus,
  launchMaintainerVaultLogin,
  runMaintainerPreflight,
  runMaintainerSmoke,
  updateMaintainerCredentials,
  updateMaintainerSettings,
  type MaintainerOptions,
} from ".";

export type MaintainerRouteOptions = MaintainerOptions;

export function maintainerRoutes(options: MaintainerRouteOptions = {}): RouteRegistrar {
  return (app) => {
    app.get("/v1/maintainer/status", () => json(getMaintainerStatus(options)));
    app.post("/v1/maintainer/settings", async (context) => {
      const parsed = await parseJsonRequest(context.req.raw);
      if (!parsed.ok || !isJsonObject(parsed.value) || typeof parsed.value.enabled !== "boolean") {
        return json({ error: parsed.ok ? "enabled must be a boolean" : parsed.error }, 400);
      }
      try {
        updateMaintainerSettings(parsed.value.enabled, options);
        return json({ ok: true });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "unable to update settings" }, 400);
      }
    });
    app.post("/v1/maintainer/credentials", async (context) => {
      const parsed = await parseJsonRequest(context.req.raw);
      if (!parsed.ok || !isJsonObject(parsed.value)) {
        return json({ error: parsed.ok ? "credentials must be an object" : parsed.error }, 400);
      }
      try {
        const apiKeys = parsed.value.apiKeys;
        if (apiKeys !== undefined && (!isJsonObject(apiKeys) || Object.values(apiKeys).some((value) => typeof value !== "string"))) {
          return json({ error: "apiKeys must be an object of string values" }, 400);
        }
        const githubToken = parsed.value.githubToken;
        if (githubToken !== undefined && typeof githubToken !== "string") {
          return json({ error: "githubToken must be a string" }, 400);
        }
        updateMaintainerCredentials({
          ...(githubToken !== undefined ? { githubToken } : {}),
          ...(apiKeys !== undefined ? { apiKeys: apiKeys as Record<string, string> } : {}),
        }, options);
        return json({ ok: true });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "unable to update credentials" }, 400);
      }
    });
    app.post("/v1/maintainer/preflight", async () => {
      try {
        return json(await runMaintainerPreflight(options));
      } catch {
        return json({ ok: false, repos: [] }, 200);
      }
    });
    app.post("/v1/maintainer/smoke", () => json(runMaintainerSmoke(options)));
    app.post("/v1/maintainer/vault-login", () => json(launchMaintainerVaultLogin(options)));
  };
}
