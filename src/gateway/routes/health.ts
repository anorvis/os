import { createMeal, deleteMeal, emitInvalidation, getHealthDashboard, parseMealInput, updateMeal } from "../../data";
import { json, parseJsonRequest, type RouteHandler } from "../http";

export function healthRoutes(): RouteHandler {
  return async (request, url) => {
    if (request.method === "GET" && url.pathname === "/v1/health/dashboard") return json(getHealthDashboard());
    if (request.method === "POST" && url.pathname === "/v1/health/meals") {
      const parsed = await parseJsonRequest(request);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseMealInput(parsed.value);
      if (!input) return json({ error: "invalid meal input" }, 400);
      const meal = createMeal(input);
      emitInvalidation({ type: "health.changed", entityId: meal.id, domain: "health" });
      return json(meal, 201);
    }
    const mealMatch = url.pathname.match(/^\/v1\/health\/meals\/([^/]+)$/);
    if (mealMatch?.[1] && request.method === "PUT") {
      const parsed = await parseJsonRequest(request);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseMealInput(parsed.value);
      if (!input) return json({ error: "invalid meal input" }, 400);
      const meal = updateMeal(decodeURIComponent(mealMatch[1]), input);
      if (!meal) return json({ error: "meal not found" }, 404);
      emitInvalidation({ type: "health.changed", entityId: meal.id, domain: "health" });
      return json(meal);
    }
    if (mealMatch?.[1] && request.method === "DELETE") {
      const deleted = deleteMeal(decodeURIComponent(mealMatch[1]));
      if (deleted) emitInvalidation({ type: "health.changed", entityId: decodeURIComponent(mealMatch[1]), domain: "health" });
      return deleted ? json({ ok: true }) : json({ error: "meal not found" }, 404);
    }
    return undefined;
  };
}
