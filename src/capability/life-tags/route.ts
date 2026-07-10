import { json, parseJsonRequest } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import {
  hideLifeTag,
  listLifeTags,
  parseLifeTagCreate,
  parseLifeTagPatch,
  updateLifeTag,
  upsertLifeTag,
} from "./data";

export function lifeTagRoutes(): RouteRegistrar {
  return (route) => {
    // Returns every record, including hidden ones, so the web can durably
    // suppress range-derived tags that the user removed.
    route.get("/v1/life/tags", () => json({ tags: listLifeTags() }));

    route.post("/v1/life/tags", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseLifeTagCreate(parsed.value);
      if (!input) return json({ error: "name is required" }, 400);
      try {
        return json({ tag: upsertLifeTag(input) }, 201);
      } catch (error) {
        return json(
          {
            error: error instanceof Error ? error.message : "invalid life tag",
          },
          400,
        );
      }
    });

    route.put("/v1/life/tags/:id", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const patch = parseLifeTagPatch(parsed.value);
      if (!patch) return json({ error: "invalid life tag patch" }, 400);
      try {
        const tag = updateLifeTag(c.req.param("id"), patch);
        if (!tag) return json({ error: "tag not found" }, 404);
        return json({ tag });
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error ? error.message : "invalid life tag patch",
          },
          400,
        );
      }
    });

    route.delete("/v1/life/tags/:id", (c) => {
      try {
        const tag = hideLifeTag(c.req.param("id"));
        return tag ? json({ tag }) : json({ error: "tag not found" }, 404);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "invalid life tag delete",
          },
          400,
        );
      }
    });
  };
}
