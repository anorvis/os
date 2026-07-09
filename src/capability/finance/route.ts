import { emitInvalidation } from "../../core/events/events";
import { json, parseJsonRequest } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import { importFinanceCsv, parseCsvImport } from "./data";

export function financeRoutes(): RouteRegistrar {
  return (route) => {
    route.post("/v1/finance/imports/csv", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseCsvImport(parsed.value);
      if (!input) return json({ error: "invalid finance import" }, 400);
      const result = importFinanceCsv(input);
      emitInvalidation({ type: "finance.changed", entityId: result.accountId, domain: "finance" });
      return json(result, 201);
    });
  };
}
