import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { serveAttachment } from "./wikiHttp";

const http = httpRouter();

auth.addHttpRoutes(http);

http.route({
  path: "/oauth/google/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return new Response("Google OAuth callback is missing code or state", {
        status: 400,
      });
    }
    try {
      const returnTo = await ctx.runAction(internal.google.completeOAuth, {
        code,
        state,
      });
      return new Response(null, {
        status: 302,
        headers: { Location: returnTo },
      });
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : "Google OAuth failed",
        { status: 400 },
      );
    }
  }),
});

http.route({
  path: "/oauth/pinterest/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return new Response("Pinterest OAuth callback is missing code or state", {
        status: 400,
      });
    }
    try {
      const returnTo = await ctx.runAction(internal.pinterest.completeOAuth, {
        code,
        state,
      });
      return new Response(null, {
        status: 302,
        headers: { Location: returnTo },
      });
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : "Pinterest OAuth failed",
        { status: 400 },
      );
    }
  }),
});

http.route({
  pathPrefix: "/files/",
  method: "GET",
  handler: serveAttachment,
});

export default http;
