import { Either, Effect } from "effect";
import { SchemaValidationError } from "../../core/effect/errors";
import { decodeUnknownResult } from "../../core/effect/schema";
import { emitInvalidation } from "../../core/events/events";
import { json, parseJsonRequest } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import { disconnectGoogle, disconnectHevy, getGoogleIntegrationSettings, getHevySettings, listIntegrations, parseHevySettings, saveGoogleIntegrationSettings, saveHevySettings, syncHevy } from "./data";
import { finishGoogleAuth, listGoogleCalendarEvents, startGoogleAuth } from "./google";
import { InvalidProviderInput, ProviderNotFound, ProviderSecretFailed, type ProviderError } from "./errors";
import { connectProviderEffect, disconnectProviderEffect, listProviders, upsertProviderDefinitionEffect } from "./providers";
import { ProviderConnectionInputSchema } from "./schema";

export function integrationRoutes(): RouteRegistrar {
  return (route) => {
    route.get("/v1/integrations", () => json(listIntegrations()));
    route.get("/v1/providers", () => json(listProviders()));

    route.post("/v1/providers", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const result = Effect.runSync(Effect.either(upsertProviderDefinitionEffect(parsed.value)));
      if (Either.isLeft(result)) return providerErrorResponse(result.left);
      emitInvalidation({ type: "integration.changed", entityId: result.right.id, domain: "integration" });
      return json(result.right, 201);
    });

    route.post("/v1/providers/:id/connection", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = decodeUnknownResult(ProviderConnectionInputSchema, parsed.value);
      if (!input.ok) return json({ error: input.error.message }, 400);
      const id = c.req.param("id");
      const result = Effect.runSync(Effect.either(connectProviderEffect(id, input.value)));
      if (Either.isLeft(result)) return providerErrorResponse(result.left);
      emitInvalidation({ type: "integration.changed", entityId: id, domain: "integration" });
      return json(result.right);
    });

    route.delete("/v1/providers/:id/connection", (c) => {
      const id = c.req.param("id");
      const result = Effect.runSync(Effect.either(disconnectProviderEffect(id)));
      if (Either.isLeft(result)) return providerErrorResponse(result.left);
      emitInvalidation({ type: "integration.changed", entityId: id, domain: "integration" });
      return json(result.right);
    });

    route.get("/v1/integrations/google/settings", () => json(getGoogleIntegrationSettings()));
    route.get("/v1/integrations/google/status", () => json(getGoogleIntegrationSettings()));

    route.post("/v1/integrations/google/settings", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      try {
        const settings = saveGoogleIntegrationSettings(parsed.value);
        emitInvalidation({ type: "integration.changed", entityId: "google", domain: "integration" });
        return json(settings);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid google settings" }, 400);
      }
    });

    route.post("/v1/integrations/google/disconnect", () => {
      const result = disconnectGoogle();
      emitInvalidation({ type: "integration.changed", entityId: "google", domain: "integration" });
      emitInvalidation({ type: "calendar.changed", entityId: "google", domain: "life" });
      return json(result);
    });

    route.post("/v1/integrations/google/auth/start", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      const body = parsed.ok ? parsed.value : {};
      try {
        const origin = new URL(c.req.url).origin;
        const auth = startGoogleAuth(body, origin);
        emitInvalidation({ type: "integration.changed", entityId: "google", domain: "integration" });
        return json(auth);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "could not start google oauth" }, 400);
      }
    });

    route.get("/v1/integrations/google/auth/callback", async (c) => {
      const url = new URL(c.req.url);
      try {
        const result = await finishGoogleAuth({
          code: url.searchParams.get("code"),
          state: url.searchParams.get("state"),
        });
        emitInvalidation({ type: "integration.changed", entityId: "google", domain: "integration" });
        emitInvalidation({ type: "calendar.changed", entityId: "google", domain: "life" });
        return Response.redirect(result.returnTo, 302);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "could not finish google oauth" }, 400);
      }
    });

    route.get("/v1/integrations/google/calendar/events", async (c) => {
      const url = new URL(c.req.url);
      try {
        return json(await listGoogleCalendarEvents({
          timeMin: url.searchParams.get("timeMin") ?? undefined,
          timeMax: url.searchParams.get("timeMax") ?? undefined,
          maxResults: url.searchParams.get("maxResults") ?? undefined,
        }));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "could not fetch google calendar" }, 502);
      }
    });

    route.get("/v1/integrations/hevy/settings", () => json(getHevySettings()));

    route.post("/v1/integrations/hevy/settings", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseHevySettings(parsed.value);
      if (!input) return json({ error: "apiKey is required" }, 400);
      const settings = saveHevySettings(input);
      emitInvalidation({ type: "integration.changed", entityId: "hevy", domain: "integration" });
      return json(settings);
    });

    route.post("/v1/integrations/hevy/disconnect", () => {
      const result = disconnectHevy();
      emitInvalidation({ type: "integration.changed", entityId: "hevy", domain: "integration" });
      return json(result);
    });

    route.post("/v1/integrations/hevy/sync", () => {
      const summary = syncHevy();
      if (!summary.ok) return json(summary, 403);
      emitInvalidation({ type: "health.changed", entityId: "hevy", domain: "health" });
      return json({ fetched: summary.fetched, created: summary.created, updated: summary.updated });
    });
  };
}

function providerErrorResponse(error: ProviderError): Response {
  if (error instanceof ProviderNotFound) return json({ error: "provider not found" }, 404);
  if (error instanceof InvalidProviderInput) return json({ error: error.message }, 400);
  if (error instanceof ProviderSecretFailed) return json({ error: error.message }, 502);
  return json({ error: providerErrorMessage(error) }, 500);
}

function providerErrorMessage(error: unknown): string {
  if (error instanceof SchemaValidationError) return error.message;
  if (error instanceof Error) return error.message;
  return "invalid provider";
}
