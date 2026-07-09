import { emitInvalidation } from "../../core/events/events";
import { json, parseJsonRequest } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import {
  createMeal,
  createWorkout,
  deleteMeal,
  parseMacroProfileInput,
  parseMealInput,
  parseWorkoutInput,
  saveMacroProfile,
  updateMeal,
  updateWorkout,
} from "./data";

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
  };
}
