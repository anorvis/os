import { getFinancePortfolio } from "../../../capability/finance/data";
import { json } from "../../../core/http/http";
import type { RouteRegistrar } from "../../../core/service/service";

export function webFinanceRoutes(): RouteRegistrar {
  return (route) => {
    route.get("/v1/finance/portfolio", () => json(getFinancePortfolio()));
  };
}
