import { Either, Effect } from "effect";
import { SchemaValidationError } from "../../core/effect/errors";
import { decodeUnknownResult } from "../../core/effect/schema";
import { emitInvalidation } from "../../core/events/events";
import { json, parseJsonRequest } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import {
  disconnectGoogle,
  disconnectHevy,
  getGoogleIntegrationSettings,
  getHevySettings,
  listHevyExerciseTemplates,
  listHevyRoutines,
  listIntegrations,
  parseHevySettings,
  saveGoogleIntegrationSettings,
  saveHevySettings,
  syncHevy,
  updateHevyRoutine,
} from "./data";
import {
  finishGoogleAuth,
  listGoogleCalendarEvents,
  startGoogleAuth,
} from "./google";
import {
  InvalidProviderInput,
  ProviderNotFound,
  ProviderSecretFailed,
  type ProviderError,
} from "./errors";
import {
  connectProviderEffect,
  disconnectProviderEffect,
  listProviders,
  upsertProviderDefinitionEffect,
} from "./providers";
import { ProviderConnectionInputSchema } from "./schema";
import {
  searchOpenFoodFacts,
  searchTheMealDb,
  type FoodSearchResult,
} from "./food";
import { searchRecipes } from "../health/recipes";
import {
  createSnapTradeConnectionPortal,
  disconnectSnapTrade,
  getSnapTradeSettings,
  saveSnapTradeSettings,
  SnapTradeError,
  syncSnapTrade,
} from "../finance/snaptrade";

export function integrationRoutes(): RouteRegistrar {
  return (route) => {
    route.get("/v1/integrations", () => json(listIntegrations()));
    route.get("/v1/providers", () => json(listProviders()));

    route.post("/v1/providers", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const result = Effect.runSync(
        Effect.either(upsertProviderDefinitionEffect(parsed.value)),
      );
      if (Either.isLeft(result)) return providerErrorResponse(result.left);
      emitInvalidation({
        type: "integration.changed",
        entityId: result.right.id,
        domain: "integration",
      });
      return json(result.right, 201);
    });

    route.post("/v1/providers/:id/connection", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = decodeUnknownResult(
        ProviderConnectionInputSchema,
        parsed.value,
      );
      if (!input.ok) return json({ error: input.error.message }, 400);
      const id = c.req.param("id");
      const result = Effect.runSync(
        Effect.either(connectProviderEffect(id, input.value)),
      );
      if (Either.isLeft(result)) return providerErrorResponse(result.left);
      emitInvalidation({
        type: "integration.changed",
        entityId: id,
        domain: "integration",
      });
      return json(result.right);
    });

    route.delete("/v1/providers/:id/connection", (c) => {
      const id = c.req.param("id");
      const result = Effect.runSync(
        Effect.either(disconnectProviderEffect(id)),
      );
      if (Either.isLeft(result)) return providerErrorResponse(result.left);
      emitInvalidation({
        type: "integration.changed",
        entityId: id,
        domain: "integration",
      });
      return json(result.right);
    });

    route.get("/v1/integrations/google/settings", () =>
      json(getGoogleIntegrationSettings()),
    );
    route.get("/v1/integrations/google/status", () =>
      json(getGoogleIntegrationSettings()),
    );

    route.post("/v1/integrations/google/settings", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      try {
        const settings = saveGoogleIntegrationSettings(parsed.value);
        emitInvalidation({
          type: "integration.changed",
          entityId: "google",
          domain: "integration",
        });
        return json(settings);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "invalid google settings",
          },
          400,
        );
      }
    });

    route.post("/v1/integrations/google/disconnect", () => {
      const result = disconnectGoogle();
      emitInvalidation({
        type: "integration.changed",
        entityId: "google",
        domain: "integration",
      });
      emitInvalidation({
        type: "calendar.changed",
        entityId: "google",
        domain: "life",
      });
      return json(result);
    });

    route.post("/v1/integrations/google/auth/start", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      const body = parsed.ok ? parsed.value : {};
      try {
        const origin = new URL(c.req.url).origin;
        const auth = startGoogleAuth(body, origin);
        emitInvalidation({
          type: "integration.changed",
          entityId: "google",
          domain: "integration",
        });
        return json(auth);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "could not start google oauth",
          },
          400,
        );
      }
    });

    route.get("/v1/integrations/google/auth/callback", async (c) => {
      const url = new URL(c.req.url);
      try {
        const result = await finishGoogleAuth({
          code: url.searchParams.get("code"),
          state: url.searchParams.get("state"),
        });
        emitInvalidation({
          type: "integration.changed",
          entityId: "google",
          domain: "integration",
        });
        emitInvalidation({
          type: "calendar.changed",
          entityId: "google",
          domain: "life",
        });
        return Response.redirect(result.returnTo, 302);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "could not finish google oauth",
          },
          400,
        );
      }
    });

    route.get("/v1/integrations/google/calendar/events", async (c) => {
      const url = new URL(c.req.url);
      try {
        return json(
          await listGoogleCalendarEvents({
            timeMin: url.searchParams.get("timeMin") ?? undefined,
            timeMax: url.searchParams.get("timeMax") ?? undefined,
            maxResults: url.searchParams.get("maxResults") ?? undefined,
          }),
        );
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "could not fetch google calendar",
          },
          502,
        );
      }
    });

    route.get("/v1/integrations/hevy/settings", () => json(getHevySettings()));

    route.get("/v1/integrations/hevy/routines", async () => {
      try {
        const result = await listHevyRoutines();
        if ("ok" in result && !result.ok) return json(result, 403);
        return json(result);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "could not fetch Hevy routines",
          },
          502,
        );
      }
    });

    route.get("/v1/integrations/hevy/exercise-templates", async () => {
      const result = await listHevyExerciseTemplates();
      if ("ok" in result && !result.ok) return json(result, 403);
      return json(result);
    });

    route.put("/v1/integrations/hevy/routines/:routineId", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      try {
        const result = await updateHevyRoutine(
          c.req.param("routineId"),
          parsed.value,
        );
        if ("ok" in result && !result.ok) return json(result, 403);
        emitInvalidation({
          type: "integration.changed",
          entityId: "hevy",
          domain: "integration",
        });
        return json(result);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "could not update Hevy routine",
          },
          400,
        );
      }
    });

    route.post("/v1/integrations/hevy/settings", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseHevySettings(parsed.value);
      if (!input) return json({ error: "apiKey is required" }, 400);
      const settings = saveHevySettings(input);
      emitInvalidation({
        type: "integration.changed",
        entityId: "hevy",
        domain: "integration",
      });
      return json(settings);
    });

    route.post("/v1/integrations/hevy/disconnect", () => {
      const result = disconnectHevy();
      emitInvalidation({
        type: "integration.changed",
        entityId: "hevy",
        domain: "integration",
      });
      return json(result);
    });

    route.post("/v1/integrations/hevy/sync", async () => {
      const summary = await syncHevy();
      if (!summary.ok) return json(summary, 403);
      emitInvalidation({
        type: "health.changed",
        entityId: "hevy",
        domain: "health",
      });
      return json({
        fetched: summary.fetched,
        created: summary.created,
        updated: summary.updated,
        measurementsFetched: summary.measurementsFetched,
        measurementsCreated: summary.measurementsCreated,
        measurementsUpdated: summary.measurementsUpdated,
      });
    });

    route.get("/v1/integrations/snaptrade/settings", () =>
      json(getSnapTradeSettings()),
    );

    route.post("/v1/integrations/snaptrade/settings", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      try {
        const settings = saveSnapTradeSettings(parsed.value);
        emitInvalidation({
          type: "integration.changed",
          entityId: "snaptrade",
          domain: "integration",
        });
        return json(settings);
      } catch (error) {
        return snapTradeErrorResponse(error, "invalid SnapTrade settings");
      }
    });

    route.post("/v1/integrations/snaptrade/portal", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      try {
        const portal = await createSnapTradeConnectionPortal(
          parsed.ok ? parsed.value : {},
        );
        return json(portal);
      } catch (error) {
        return snapTradeErrorResponse(
          error,
          "could not create SnapTrade connection portal",
        );
      }
    });

    route.post("/v1/integrations/snaptrade/sync", async () => {
      try {
        const summary = await syncSnapTrade();
        emitInvalidation({
          type: "finance.changed",
          entityId: "snaptrade",
          domain: "finance",
        });
        return json(summary);
      } catch (error) {
        return snapTradeErrorResponse(error, "SnapTrade sync failed");
      }
    });

    route.delete("/v1/integrations/snaptrade/disconnect", () => {
      const result = disconnectSnapTrade();
      emitInvalidation({
        type: "integration.changed",
        entityId: "snaptrade",
        domain: "integration",
      });
      emitInvalidation({
        type: "finance.changed",
        entityId: "snaptrade",
        domain: "finance",
      });
      return json(result);
    });

    route.get("/v1/integrations/recipes/search", async (c) => {
      const query = (new URL(c.req.url).searchParams.get("q") ?? "").trim();
      const attribution = "Recipe data from TheMealDB (themealdb.com)";
      if (!query) return json({ query, attribution, results: [] });
      try {
        const results = await searchTheMealDb(query);
        return json({ query, attribution, results });
      } catch {
        return json({ error: "recipe search failed" }, 502);
      }
    });

    route.get("/v1/integrations/food/search", async (c) => {
      const url = new URL(c.req.url);
      const query = (url.searchParams.get("q") ?? "").trim();
      const provider = url.searchParams.get("provider") ?? "all";
      const providers: Record<
        string,
        { status: "ok" | "error" | "unavailable"; count: number }
      > = {};
      const results: FoodSearchResult[] = [];
      if (!query) return json({ query, provider, providers, results });
      const selected =
        provider === "all" ? ["recipe", "openfoodfacts"] : [provider];
      for (const name of selected) {
        if (name !== "recipe" && name !== "openfoodfacts") {
          providers[name] = { status: "unavailable", count: 0 };
        }
      }
      const known = selected.filter(
        (name): name is "recipe" | "openfoodfacts" =>
          name === "recipe" || name === "openfoodfacts",
      );
      const settled = await Promise.allSettled(
        known.map((name) =>
          name === "openfoodfacts"
            ? searchOpenFoodFacts(query)
            : Promise.resolve().then(() =>
                searchRecipes(query).map((recipe) => ({
                  id: recipe.id,
                  name: recipe.title,
                  calories: recipe.calories,
                  proteinGrams: recipe.proteinGrams,
                  carbsGrams: recipe.carbsGrams,
                  fatGrams: recipe.fatGrams,
                  provider: "recipe",
                })),
              ),
        ),
      );
      known.forEach((name, index) => {
        const outcome = settled[index];
        if (outcome.status === "fulfilled") {
          providers[name] = { status: "ok", count: outcome.value.length };
          results.push(...outcome.value);
        } else {
          providers[name] = { status: "error", count: 0 };
        }
      });
      return json({ query, provider, providers, results });
    });
  };
}

function providerErrorResponse(error: ProviderError): Response {
  if (error instanceof ProviderNotFound)
    return json({ error: "provider not found" }, 404);
  if (error instanceof InvalidProviderInput)
    return json({ error: error.message }, 400);
  if (error instanceof ProviderSecretFailed)
    return json({ error: error.message }, 502);
  return json({ error: providerErrorMessage(error) }, 500);
}

function providerErrorMessage(error: unknown): string {
  if (error instanceof SchemaValidationError) return error.message;
  if (error instanceof Error) return error.message;
  return "invalid provider";
}

function snapTradeErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof SnapTradeError) {
    const status =
      error.code === "not_connected"
        ? 409
        : error.code === "invalid_settings" ||
            error.code === "connection_type_locked" ||
            error.code === "invalid_redirect"
          ? 400
          : 502;
    return json(
      { error: error.message, code: error.code ?? undefined },
      status,
    );
  }
  return json(
    { error: error instanceof Error ? error.message : fallback },
    502,
  );
}
