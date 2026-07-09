import { decodeUnknownResult } from "../../core/effect/schema";
import { emitInvalidation } from "../../core/events/events";
import { json, parseJsonRequest } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import { completeTask, createTask, deleteTask, getTask, getTaskSession, listTaskSessions, listTasks, parseTaskInput, parseTaskPatch, updateTask, upsertTaskSession } from "./data";
import { TaskSessionInputSchema } from "./schema";

export function taskRoutes(): RouteRegistrar {
  return (route) => {
    route.get("/v1/tasks", () => json({ tasks: listTasks() }));

    route.post("/v1/tasks", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      if (hasRetiredKeys(parsed.value, ["date"])) return json({ error: "invalid task input" }, 400);
      const input = parseTaskInput(parsed.value);
      if (!input) return json({ error: "title is required" }, 400);
      const task = createTask(input);
      emitInvalidation({ type: "task.changed", entityId: task.id, domain: "life" });
      return json(task, 201);
    });

    route.get("/v1/tasks/plan", () => json(taskPlan()));

    route.patch("/v1/tasks/sessions/:id", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      if (hasRetiredKeys(parsed.value, ["start", "end", "completed"])) return json({ error: "startAt and endAt are required" }, 400);
      const input = decodeUnknownResult(TaskSessionInputSchema, parsed.value);
      if (!input.ok) return json({ error: "startAt and endAt are required" }, 400);
      try {
        const id = c.req.param("id");
        if (!getTaskSession(id) && !getTask(id)) return json({ error: "task session not found" }, 404);
        const session = upsertTaskSession(id, input.value);
        if (!session) return json({ error: "task session not found" }, 404);
        emitInvalidation({ type: "task.changed", entityId: session.id, domain: "life" });
        return json(session);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid task session" }, 400);
      }
    });

    route.patch("/v1/tasks/:id/complete", (c) => {
      const task = completeTask(c.req.param("id"));
      if (!task) return json({ error: "task not found" }, 404);
      emitInvalidation({ type: "task.changed", entityId: task.id, domain: "life" });
      return json(task);
    });

    route.patch("/v1/tasks/:id", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      if (hasRetiredKeys(parsed.value, ["date"])) return json({ error: "invalid task patch" }, 400);
      const patch = parseTaskPatch(parsed.value);
      if (!patch) return json({ error: "invalid task patch" }, 400);
      const task = updateTask(c.req.param("id"), patch);
      if (!task) return json({ error: "task not found" }, 404);
      emitInvalidation({ type: "task.changed", entityId: task.id, domain: "life" });
      return json(task);
    });

    route.delete("/v1/tasks/:id", (c) => {
      const id = c.req.param("id");
      const deleted = deleteTask(id);
      if (deleted) emitInvalidation({ type: "task.changed", entityId: id, domain: "life" });
      return deleted ? json({ ok: true }) : json({ error: "task not found" }, 404);
    });
  };
}

function taskPlan() {
  return {
    tasks: listTasks().map((task) => ({
      id: task.id,
      title: task.title,
      notes: task.notes,
      status: task.status,
      priority: task.priority,
      dueAt: task.dueAt,
      source: task.source,
      sourceId: task.sourceId,
      durationMinutes: task.durationMinutes,
      links: task.links,
      multiSession: task.multiSession,
      completedAt: task.completedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })),
    sessions: listTaskSessions().map((session) => ({
      id: session.id,
      taskId: session.taskId,
      startAt: session.startAt,
      endAt: session.endAt,
      status: session.status,
      source: session.source,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    })),
    prepPackages: [],
  };
}

function hasRetiredKeys(value: unknown, keys: string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    keys.some((key) => key in value)
  );
}
