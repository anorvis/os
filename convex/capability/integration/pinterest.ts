"use node";

import { ConvexError, v } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { action, internalAction } from "../../_generated/server";
import {
  decryptCredentials,
  encryptCredentials,
  randomState,
  stateHash,
} from "../../platform/auth/credentials";

const defaultScopes = ["boards:read", "pins:read"];

type PinterestCredentials = {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
};
type PinterestConnection = Extract<Doc<"providerConnections">, { provider: "pinterest" }>;

type PinterestPin = {
  id?: unknown;
  title?: unknown;
  link?: unknown;
  media?: {
    images?: Record<string, { url?: unknown }>;
  };
};

function required(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new ConvexError({ code: "INVALID_INPUT", message: `${label} is required` });
  return result;
}

function safeUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConvexError({ code: "INVALID_INPUT", message: `${label} must be an absolute URL` });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConvexError({ code: "INVALID_INPUT", message: `${label} must use HTTP or HTTPS` });
  }
  return url.toString();
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function credentials(value: Record<string, string>): PinterestCredentials {
  const clientId = value.clientId;
  const clientSecret = value.clientSecret;
  if (!clientId || !clientSecret) throw new Error("Pinterest client credentials are missing");
  return {
    clientId,
    clientSecret,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
  };
}

async function pinterestJson(path: string, accessToken: string) {
  const response = await fetch(`https://api.pinterest.com/v5${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(string(payload.message) ?? string(payload.error) ?? "Pinterest request failed");
  }
  return payload;
}

async function tokenRequest(body: URLSearchParams, current: PinterestCredentials) {
  const response = await fetch("https://api.pinterest.com/v5/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${current.clientId}:${current.clientSecret}`).toString("base64")}`,
    },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(string(payload.error_description) ?? string(payload.message) ?? string(payload.error) ?? "Pinterest token exchange failed");
  }
  return payload;
}

function boardSlug(boardUrl?: string): string | undefined {
  if (!boardUrl) return undefined;
  let url: URL;
  try {
    url = new URL(boardUrl);
  } catch {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Pinterest board URL must be absolute" });
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  return parts[1].toLowerCase();
}

async function resolveBoardId(accessToken: string, input: { boardUrl?: string; boardId?: string }) {
  if (input.boardId?.trim()) return input.boardId.trim();
  const slug = boardSlug(input.boardUrl);
  if (!slug) throw new ConvexError({ code: "INVALID_INPUT", message: "Pinterest board URL or board ID is required" });
  let bookmark: string | undefined;
  do {
    const params = new URLSearchParams({ page_size: "100" });
    if (bookmark) params.set("bookmark", bookmark);
    const payload = await pinterestJson(`/boards?${params.toString()}`, accessToken);
    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const item of items) {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const id = string(record.id);
        const name = string(record.name)?.toLowerCase().replace(/\s+/g, "-");
        const url = string(record.url);
        if (id && (name === slug || url?.toLowerCase().includes(`/${slug}/`))) return id;
      }
    }
    bookmark = string(payload.bookmark);
  } while (bookmark);
  throw new ConvexError({ code: "NOT_FOUND", message: "Pinterest board was not found for the connected account" });
}

function pinImage(pin: PinterestPin): string | undefined {
  const images = pin.media?.images;
  if (!images) return undefined;
  for (const key of ["1200x", "600x", "400x300", "150x150", "originals"]) {
    const url = string(images[key]?.url);
    if (url) return url;
  }
  for (const image of Object.values(images)) {
    const url = string(image.url);
    if (url) return url;
  }
  return undefined;
}

export const settings = action({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args): Promise<{
    connected: boolean;
    hasClientConfig: boolean;
    hasClientId: boolean;
    hasClientSecret: boolean;
    scopes: string[];
    canAutoRenew: boolean;
    accessTokenExpiresAt: number | null;
  }> => {
    const connection = (await ctx.runQuery(internal.capability.integration.connection, {
      workspaceId: args.workspaceId,
      provider: "pinterest",
    })) as PinterestConnection | null;
    const credentials = connection?.credentials
      ? decryptCredentials(connection.credentials)
      : {};
    return {
      connected: connection?.status === "connected",
      hasClientConfig: Boolean(credentials.clientId && credentials.clientSecret),
      hasClientId: Boolean(credentials.clientId),
      hasClientSecret: Boolean(credentials.clientSecret),
      scopes: Array.isArray(connection?.scopes) ? connection.scopes : defaultScopes,
      canAutoRenew: connection?.status === "connected" && Boolean(credentials.refreshToken),
      accessTokenExpiresAt: connection?.accessTokenExpiresAt ?? null,
    };
  },
});

export const saveSettings = action({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    clientId: v.string(),
    clientSecret: v.string(),
  },
  handler: (_ctx, args) => ({
    connected: false,
    hasClientConfig: Boolean(required(args.clientId, "Pinterest client ID") && required(args.clientSecret, "Pinterest client secret")),
    hasClientId: true,
    hasClientSecret: true,
    scopes: defaultScopes,
    canAutoRenew: false,
    accessTokenExpiresAt: null,
  }),
});

export const start = action({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    clientId: v.string(),
    clientSecret: v.string(),
    redirectUri: v.string(),
    returnTo: v.string(),
    scopes: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const clientId = required(args.clientId, "Pinterest client ID");
    const clientSecret = required(args.clientSecret, "Pinterest client secret");
    const redirectUri = safeUrl(args.redirectUri, "Pinterest redirect URI");
    const returnTo = safeUrl(args.returnTo, "Pinterest return URL");
    const scopes = args.scopes?.map((scope) => scope.trim()).filter(Boolean) ?? defaultScopes;
    const state = randomState();
    await ctx.runMutation(internal.capability.integration.beginPinterest, {
      workspaceId: args.workspaceId,
      credentials: encryptCredentials({ clientId, clientSecret }),
      scopes,
      stateHash: stateHash(state),
      redirectUri,
      returnTo,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    const url = new URL("https://www.pinterest.com/oauth/");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopes.join(","));
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString(), authUrl: url.toString(), state, scopes };
  },
});

export const completeOAuth = internalAction({
  args: { code: v.string(), state: v.string() },
  handler: async (ctx, args): Promise<string> => {
    const oauthState = await ctx.runMutation(internal.capability.integration.consumePinterestState, {
      stateHash: stateHash(args.state),
      now: Date.now(),
    });
    const connection = await ctx.runQuery(internal.capability.integration.connectionByWorkspace, {
      workspaceId: oauthState.workspaceId,
      provider: "pinterest",
    });
    if (connection?.provider !== "pinterest" || connection.credentials === undefined) {
      throw new Error("Pinterest connection is not configured");
    }
    const current = credentials(decryptCredentials(connection.credentials));
    const payload = await tokenRequest(
      new URLSearchParams({
        code: args.code,
        redirect_uri: oauthState.redirectUri,
        grant_type: "authorization_code",
      }),
      current,
    );
    const accessToken = string(payload.access_token);
    const refreshToken = string(payload.refresh_token) ?? current.refreshToken;
    if (!accessToken) throw new Error("Pinterest did not return an access token");
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
    const scopes = string(payload.scope)?.split(/[\s,]+/).filter(Boolean) ?? connection.scopes;
    await ctx.runMutation(internal.capability.integration.finishPinterest, {
      workspaceId: oauthState.workspaceId,
      credentials: encryptCredentials({
        clientId: current.clientId,
        clientSecret: current.clientSecret,
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
      }),
      scopes,
      accessTokenExpiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    });
    return oauthState.returnTo;
  },
});

export const boardImages = action({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    boardUrl: v.optional(v.string()),
    boardId: v.optional(v.string()),
    maxResults: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ images: Array<{ id: string; imageUrl: string; title: string | null; link: string | null }> }> => {
    const connection = (await ctx.runQuery(internal.capability.integration.connection, {
      workspaceId: args.workspaceId,
      provider: "pinterest",
    })) as PinterestConnection | null;
    if (connection?.provider !== "pinterest" || connection.status !== "connected" || connection.credentials === undefined) {
      throw new ConvexError({ code: "NOT_CONNECTED", message: "Pinterest is not connected" });
    }
    const current = credentials(decryptCredentials(connection.credentials));
    if (!current.accessToken) throw new ConvexError({ code: "NOT_CONNECTED", message: "Pinterest access token is missing" });
    const boardId = await resolveBoardId(current.accessToken, args);
    const maxResults = Math.min(Math.max(Math.trunc(args.maxResults ?? 50), 1), 100);
    const payload = await pinterestJson(`/boards/${encodeURIComponent(boardId)}/pins?page_size=${maxResults}`, current.accessToken);
    const items = Array.isArray(payload.items) ? (payload.items as PinterestPin[]) : [];
    return {
      images: items.flatMap((pin) => {
        const id = string(pin.id);
        const imageUrl = pinImage(pin);
        if (!id || !imageUrl) return [];
        return [{ id, imageUrl, title: string(pin.title) ?? null, link: string(pin.link) ?? null }];
      }),
    };
  },
});
