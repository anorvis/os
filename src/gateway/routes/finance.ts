import { emitInvalidation, getFinancePortfolio, importFinanceCsv, parseCsvImport } from "../../data";
import { json, parseJsonRequest, type RouteHandler } from "../http";

export function financeRoutes(): RouteHandler {
  return async (request, url) => {
    if (request.method === "GET" && url.pathname === "/v1/finance/portfolio") return json(getFinancePortfolio());
    if (request.method === "POST" && url.pathname === "/v1/finance/imports/csv") {
      const parsed = await parseJsonRequest(request);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseCsvImport(parsed.value);
      if (!input) return json({ error: "invalid finance import" }, 400);
      const result = importFinanceCsv(input);
      emitInvalidation({ type: "finance.changed", entityId: result.accountId, domain: "finance" });
      return json(result, 201);
    }
    return undefined;
  };
}
