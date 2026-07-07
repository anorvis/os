import { getLifeSnapshot } from "../../data";
import { json, type RouteHandler } from "../http";

export function lifeRoutes(): RouteHandler {
  return (_request, url) => {
    if (_request.method === "GET" && url.pathname === "/v1/life/snapshot") return json(getLifeSnapshot());
    return undefined;
  };
}
