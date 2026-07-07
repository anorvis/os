import { getOverview } from "../../data";
import { json, type RouteHandler } from "../http";

export function overviewRoutes(): RouteHandler {
  return (request, url) => {
    if (request.method === "GET" && url.pathname === "/v1/overview") return json(getOverview());
    return undefined;
  };
}
