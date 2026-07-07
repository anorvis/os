import { completeTask, createTask, deleteTask, emitInvalidation, getTask, getTaskSession, listTaskSessions, listTasks, parseTaskInput, parseTaskPatch, updateTask, upsertTaskSession } from "../../data";
import { isJsonObject, json, parseJsonRequest, type RouteHandler } from "../http";

export function taskRoutes(): RouteHandler {
  return async (request, url) => {
    if (request.method === "GET" && url.pathname === "/v1/tasks") return json({ tasks: listTasks() });
    if (request.method === "POST" && url.pathname === "/v1/tasks") {
      const parsed = await parseJsonRequest(request);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseTaskInput(parsed.value);
      if (!input) return json({ error: "title is required" }, 400);
      const task = createTask(input);
      emitInvalidation({ type: "task.changed", entityId: task.id, domain: "life" });
      return json(task, 201);
    }
    if (request.method === "GET" && url.pathname === "/v1/tasks/plan") return json(taskPlan());
    const taskSessionMatch = url.pathname.match(/^\/v1\/tasks\/sessions\/([^/]+)$/);
    if (taskSessionMatch?.[1] && request.method === "PATCH") {
      const parsed = await parseJsonRequest(request);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      if (!isJsonObject(parsed.value) || typeof parsed.value.start !== "string" || typeof parsed.value.end !== "string") return json({ error: "start and end are required" }, 400);
      try {
        const sessionId = decodeURIComponent(taskSessionMatch[1]);
        if (!getTaskSession(sessionId) && !getTask(sessionId)) return json({ error: "task session not found" }, 404);
        const session = upsertTaskSession(sessionId, { start: parsed.value.start, end: parsed.value.end });
        if (!session) return json({ error: "task session not found" }, 404);
        emitInvalidation({ type: "task.changed", entityId: session.id, domain: "life" });
        return json(session);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid task session" }, 400);
      }
    }
    const taskCompleteMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/complete$/);
    if (taskCompleteMatch?.[1] && request.method === "PATCH") {
      const task = completeTask(decodeURIComponent(taskCompleteMatch[1]));
      if (!task) return json({ error: "task not found" }, 404);
      emitInvalidation({ type: "task.changed", entityId: task.id, domain: "life" });
      return json(task);
    }
    const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
    if (taskMatch?.[1] && request.method === "PATCH") {
      const parsed = await parseJsonRequest(request);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const patch = parseTaskPatch(parsed.value);
      if (!patch) return json({ error: "invalid task patch" }, 400);
      const task = updateTask(decodeURIComponent(taskMatch[1]), patch);
      if (!task) return json({ error: "task not found" }, 404);
      emitInvalidation({ type: "task.changed", entityId: task.id, domain: "life" });
      return json(task);
    }
    if (taskMatch?.[1] && request.method === "DELETE") {
      const deleted = deleteTask(decodeURIComponent(taskMatch[1]));
      if (deleted) emitInvalidation({ type: "task.changed", entityId: decodeURIComponent(taskMatch[1]), domain: "life" });
      return deleted ? json({ ok: true }) : json({ error: "task not found" }, 404);
    }
    return undefined;
  };
}

function taskPlan() {
  return {
    tasks: listTasks().map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      date: task.dueAt,
      priority: task.priority ?? undefined,
      notes: task.notes ?? undefined,
      links: task.links,
      durationMinutes: task.durationMinutes ?? undefined,
      multiSession: task.multiSession,
    })),
    sessions: listTaskSessions().map((session) => ({
      id: session.id,
      taskId: session.taskId,
      completed: session.status === "completed",
      start: session.startAt,
      end: session.endAt,
      conflictState: "none",
    })),
    prepPackages: [],
  };
}
