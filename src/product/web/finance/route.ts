import { getFinancePortfolio } from "../../../capability/finance/data";
import {
  FinanceRateError,
  getFinanceReportingDashboard,
  parseReportingCurrency,
} from "../../../capability/finance/rates";
import { json } from "../../../core/http/http";
import type { RouteRegistrar } from "../../../core/service/service";

export function webFinanceRoutes(): RouteRegistrar {
  return (route) => {
    route.get("/v1/finance/portfolio", () => json(getFinancePortfolio()));
    route.get("/v1/finance/dashboard", async (c) => {
      const currency = parseReportingCurrency(
        new URL(c.req.url).searchParams.get("currency"),
      );
      if (!currency) {
        return json(
          {
            error: "currency query parameter is required",
            code: "invalid_currency",
          },
          400,
        );
      }
      try {
        return json(await getFinanceReportingDashboard(currency));
      } catch (error) {
        if (error instanceof FinanceRateError) {
          return json(
            { error: error.message, code: error.code },
            error.code === "invalid_currency" ? 400 : 502,
          );
        }
        return json({ error: "finance conversion failed" }, 502);
      }
    });
  };
}
