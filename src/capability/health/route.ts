import { emitInvalidation } from "../../core/events/events";
import { json, parseJsonRequest } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import { decodeUnknownResult } from "../../core/effect/schema";
import {
  createMeal,
  createWorkout,
  deleteMeal,
  isRecord,
  parseMacroProfileInput,
  parseMealInput,
  parseWorkoutInput,
  saveMacroProfile,
  updateMeal,
  updateWorkout,
} from "./data";
import {
  createRecipe,
  deleteRecipe,
  listRecipes,
  parseRecipeInput,
  setRecipeFavorite,
  updateRecipe,
} from "./recipes";
import {
  describeImportError,
  importRecipeFromUrl,
} from "../integration/recipe-import";
import { UrlImportBodySchema } from "./schema";

export function healthRoutes(): RouteRegistrar {
  return (route) => {
    route.post("/v1/health/meals", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseMealInput(parsed.value);
      if (!input) return json({ error: "invalid meal input" }, 400);
      const meal = createMeal(input);
      emitInvalidation({ type: "health.changed", entityId: meal.id, domain: "health" });
      return json(meal, 201);
    });

    route.post("/v1/health/macro-profile", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseMacroProfileInput(parsed.value);
      if (!input) return json({ error: "invalid macro profile input" }, 400);
      const profile = saveMacroProfile(input);
      emitInvalidation({ type: "health.changed", entityId: profile.id, domain: "health" });
      return json(profile, 201);
    });

    route.post("/v1/health/workouts", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseWorkoutInput(parsed.value);
      if (!input) return json({ error: "invalid workout input" }, 400);
      const workout = createWorkout(input);
      emitInvalidation({ type: "health.changed", entityId: workout.id, domain: "health" });
      return json(workout, 201);
    });

    route.put("/v1/health/workouts/:id", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseWorkoutInput(parsed.value);
      if (!input) return json({ error: "invalid workout input" }, 400);
      const workout = updateWorkout(c.req.param("id"), input);
      if (!workout) return json({ error: "workout not found" }, 404);
      emitInvalidation({ type: "health.changed", entityId: workout.id, domain: "health" });
      return json(workout);
    });

    route.put("/v1/health/meals/:id", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseMealInput(parsed.value);
      if (!input) return json({ error: "invalid meal input" }, 400);
      const meal = updateMeal(c.req.param("id"), input);
      if (!meal) return json({ error: "meal not found" }, 404);
      emitInvalidation({ type: "health.changed", entityId: meal.id, domain: "health" });
      return json(meal);
    });

    route.delete("/v1/health/meals/:id", (c) => {
      const id = c.req.param("id");
      const deleted = deleteMeal(id);
      if (deleted) emitInvalidation({ type: "health.changed", entityId: id, domain: "health" });
      return deleted ? json({ ok: true }) : json({ error: "meal not found" }, 404);
    });

    route.get("/v1/health/recipes", () => json({ recipes: listRecipes() }));

    route.post("/v1/health/recipes", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseRecipeInput(parsed.value);
      if (!input) return json({ error: "invalid recipe input" }, 400);
      const recipe = createRecipe(input);
      emitInvalidation({ type: "health.changed", entityId: recipe.id, domain: "health" });
      return json(recipe, 201);
    });

    route.post("/v1/health/recipes/import", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const decoded = decodeUnknownResult(UrlImportBodySchema, parsed.value);
      if (!decoded.ok) return json({ error: "recipe url is required" }, 400);
      try {
        const input = await importRecipeFromUrl(decoded.value.url);
        const recipe = createRecipe(input);
        emitInvalidation({ type: "health.changed", entityId: recipe.id, domain: "health" });
        return json(recipe, 201);
      } catch (error) {
        const { status, message } = describeImportError(error);
        return json({ error: message }, status);
      }
    });

    route.put("/v1/health/recipes/:id", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseRecipeInput(parsed.value);
      if (!input) return json({ error: "invalid recipe input" }, 400);
      const recipe = updateRecipe(c.req.param("id"), input);
      if (!recipe) return json({ error: "recipe not found" }, 404);
      emitInvalidation({ type: "health.changed", entityId: recipe.id, domain: "health" });
      return json(recipe);
    });

    route.delete("/v1/health/recipes/:id", (c) => {
      const id = c.req.param("id");
      const deleted = deleteRecipe(id);
      if (deleted) emitInvalidation({ type: "health.changed", entityId: id, domain: "health" });
      return deleted ? json({ ok: true }) : json({ error: "recipe not found" }, 404);
    });

    route.post("/v1/health/recipes/:id/favorite", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const body = parsed.value;
      const isFavorite = isRecord(body) && body.isFavorite === true;
      const recipe = setRecipeFavorite(c.req.param("id"), isFavorite);
      if (!recipe) return json({ error: "recipe not found" }, 404);
      emitInvalidation({ type: "health.changed", entityId: recipe.id, domain: "health" });
      return json(recipe);
    });
  };
}
