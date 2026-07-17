"use node";

import { createHash } from "node:crypto";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { action, type ActionCtx, internalAction } from "../../_generated/server";
import { throwIfRateLimited } from "./rateLimit";
import {
  decryptCredentials,
  encryptCredentials,
  randomState,
  stateHash,
} from "../../platform/auth/credentials";

const defaultScopes = ["https://www.googleapis.com/auth/calendar.readonly"];

type GoogleCredentials = {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
};
type GoogleConnection = Extract<Doc<"providerConnections">, { provider: "google" }>;

type GoogleEvent = {
  id?: unknown;
  summary?: unknown;
  description?: unknown;
  location?: unknown;
  updated?: unknown;
  start?: { date?: unknown; dateTime?: unknown; timeZone?: unknown };
  end?: { date?: unknown; dateTime?: unknown; timeZone?: unknown };
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

function dayAt(timestamp: number, timezone?: string): string {
  if (!timezone) return new Date(timestamp).toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function previousDay(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function parseEvent(event: GoogleEvent, calendarId: string) {
  const providerEventId = string(event.id);
  if (!providerEventId || !event.start || !event.end) return undefined;
  const startDate = string(event.start.date);
  const endDate = string(event.end.date);
  let schedule;
  let startDay;
  let endDay;
  if (startDate && endDate) {
    schedule = {
      kind: "all_day" as const,
      startDate,
      endDateExclusive: endDate,
    };
    startDay = startDate;
    endDay = previousDay(endDate);
  } else {
    const startText = string(event.start.dateTime);
    const endText = string(event.end.dateTime);
    if (!startText || !endText) return undefined;
    const startAt = Date.parse(startText);
    const endAt = Date.parse(endText);
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
      return undefined;
    }
    const timezone = string(event.start.timeZone) ?? string(event.end.timeZone);
    schedule = { kind: "timed" as const, startAt, endAt, timezone };
    startDay = dayAt(startAt, timezone);
    endDay = dayAt(endAt - 1, timezone);
  }
  return {
    providerEventId,
    calendarId,
    summary: string(event.summary) ?? "Untitled event",
    schedule,
    startDay,
    endDay,
    location: string(event.location),
    description: string(event.description),
    sourceHash: createHash("sha256")
      .update(JSON.stringify(event), "utf8")
      .digest("hex"),
  };
}

function credentials(value: Record<string, string>): GoogleCredentials {
  const clientId = value.clientId;
  const clientSecret = value.clientSecret;
  if (!clientId || !clientSecret) throw new Error("Google client credentials are missing");
  return {
    clientId,
    clientSecret,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
  };
}

async function tokenRequest(body: URLSearchParams) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(string(payload.error_description) ?? string(payload.error) ?? "Google token exchange failed");
  }
  return payload;
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
      provider: "google",
    })) as GoogleConnection | null;
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
    hasClientConfig: Boolean(required(args.clientId, "Google client ID") && required(args.clientSecret, "Google client secret")),
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
    clientId: v.optional(v.string()),
    clientSecret: v.optional(v.string()),
    redirectUri: v.string(),
    returnTo: v.string(),
    scopes: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const workspaceId = await ctx.runQuery(
      internal.capability.integration.authorizeWorkspace,
      { workspaceId: args.workspaceId },
    );
    let clientId = args.clientId?.trim() ?? "";
    let clientSecret = args.clientSecret?.trim() ?? "";
    if (!clientId || !clientSecret) {
      // Re-sign-in path: the OAuth client configuration survives disconnect,
      // so signing back in never requires re-entering the keys.
      const connection = await ctx.runQuery(
        internal.capability.integration.connectionByWorkspace,
        { workspaceId, provider: "google" },
      );
      if (connection?.provider === "google" && connection.credentials !== undefined) {
        const stored = credentials(decryptCredentials(connection.credentials));
        clientId = clientId || stored.clientId;
        clientSecret = clientSecret || stored.clientSecret;
      }
    }
    if (!clientId || !clientSecret) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Google client ID and secret are required for the first sign-in",
      });
    }
    const redirectUri = safeUrl(args.redirectUri, "Google redirect URI");
    const returnTo = safeUrl(args.returnTo, "Google return URL");
    const scopes = args.scopes?.map((scope) => scope.trim()).filter(Boolean) ?? defaultScopes;
    const state = randomState();
    await ctx.runMutation(internal.capability.integration.beginGoogle, {
      workspaceId,
      credentials: encryptCredentials({ clientId, clientSecret }),
      scopes,
      stateHash: stateHash(state),
      redirectUri,
      returnTo,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString() };
  },
});

export const disconnect = action({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args): Promise<{ ok: true; hasClientConfig: boolean }> => {
    const workspaceId = await ctx.runQuery(
      internal.capability.integration.authorizeWorkspace,
      { workspaceId: args.workspaceId },
    );
    const connection = await ctx.runQuery(
      internal.capability.integration.connectionByWorkspace,
      { workspaceId, provider: "google" },
    );
    if (connection?.provider !== "google") return { ok: true, hasClientConfig: false };
    let kept: { clientId: string; clientSecret: string } | null = null;
    let revoke: string | undefined;
    if (connection.credentials !== undefined) {
      try {
        const stored = credentials(decryptCredentials(connection.credentials));
        kept = { clientId: stored.clientId, clientSecret: stored.clientSecret };
        revoke = stored.refreshToken ?? stored.accessToken;
      } catch {
        kept = null;
      }
    }
    // Disconnect locally first: revocation is best-effort and must never
    // gate or delay dropping the connection and its queued sync work.
    await ctx.runMutation(internal.capability.integration.resetGoogleConnection, {
      workspaceId,
      credentials: kept === null ? undefined : encryptCredentials(kept),
    });
    if (revoke) {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: revoke }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined);
    }
    return { ok: true, hasClientConfig: kept !== null };
  },
});

export const completeOAuth = internalAction({
  args: { code: v.string(), state: v.string() },
  handler: async (ctx, args): Promise<string> => {
    const oauthState = await ctx.runMutation(internal.capability.integration.consumeGoogleState, {
      stateHash: stateHash(args.state),
      now: Date.now(),
    });
    const connection = await ctx.runQuery(internal.capability.integration.connectionByWorkspace, {
      workspaceId: oauthState.workspaceId,
      provider: "google",
    });
    if (connection?.provider !== "google" || connection.credentials === undefined) {
      throw new Error("Google connection is not configured");
    }
    const current = credentials(decryptCredentials(connection.credentials));
    const payload = await tokenRequest(
      new URLSearchParams({
        code: args.code,
        client_id: current.clientId,
        client_secret: current.clientSecret,
        redirect_uri: oauthState.redirectUri,
        grant_type: "authorization_code",
      }),
    );
    const accessToken = string(payload.access_token);
    const refreshToken = string(payload.refresh_token) ?? current.refreshToken;
    if (!accessToken || !refreshToken) {
      throw new Error("Google did not return the required access and refresh tokens");
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
    const scopes = string(payload.scope)?.split(/\s+/).filter(Boolean) ?? connection.scopes;
    await ctx.runMutation(internal.capability.integration.finishGoogle, {
      workspaceId: oauthState.workspaceId,
      credentials: encryptCredentials({
        clientId: current.clientId,
        clientSecret: current.clientSecret,
        accessToken,
        refreshToken,
      }),
      scopes,
      accessTokenExpiresAt: Date.now() + expiresIn * 1000,
    });
    // Populate the calendar immediately instead of waiting for the cron, and
    // hand the landing page the exact job so it can refresh when it finishes.
    const jobId = await ctx.runMutation(
      internal.capability.integration.jobs.enqueueProviderSync,
      {
        workspaceId: oauthState.workspaceId,
        provider: "google",
        kind: "manual",
      },
    );
    const landing = new URL(oauthState.returnTo);
    landing.searchParams.set("googleSync", String(jobId));
    return landing.toString();
  },
});

async function googleAccess(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<{ accessToken: string }> {
  const connection = await ctx.runQuery(
    internal.capability.integration.connectionByWorkspace,
    { workspaceId, provider: "google" },
  );
  if (
    connection?.provider !== "google" ||
    connection.status !== "connected" ||
    connection.credentials === undefined
  ) {
    throw new ConvexError({ code: "NOT_CONNECTED", message: "Google is not connected" });
  }
  const current = credentials(decryptCredentials(connection.credentials));
  let accessToken = current.accessToken;
  if (
    !accessToken ||
    connection.accessTokenExpiresAt === undefined ||
    connection.accessTokenExpiresAt <= Date.now() + 60_000
  ) {
    if (!current.refreshToken) throw new Error("Google refresh token is missing");
    let payload: Record<string, unknown>;
    try {
      payload = await tokenRequest(
        new URLSearchParams({
          refresh_token: current.refreshToken,
          client_id: current.clientId,
          client_secret: current.clientSecret,
          grant_type: "refresh_token",
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A revoked or expired refresh token never recovers by retrying; flag
      // the connection so the dashboard prompts a reconnect and scheduled
      // syncs stop failing every six hours.
      if (/invalid_grant|expired|revoked/i.test(message)) {
        await ctx.runMutation(
          internal.capability.integration.markGoogleReauthRequired,
          { workspaceId },
        );
        throw new ConvexError({
          code: "REAUTH_REQUIRED",
          message:
            "Google access expired or was revoked — reconnect Google Calendar from the dashboard.",
        });
      }
      throw error;
    }
    accessToken = string(payload.access_token);
    if (!accessToken) throw new Error("Google token refresh returned no access token");
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
    await ctx.runMutation(internal.capability.integration.finishGoogle, {
      workspaceId: connection.workspaceId,
      credentials: encryptCredentials({
        clientId: current.clientId,
        clientSecret: current.clientSecret,
        accessToken,
        refreshToken: current.refreshToken,
      }),
      scopes: connection.scopes,
      accessTokenExpiresAt: Date.now() + expiresIn * 1000,
    });
  }
  return { accessToken };
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// The calendars the user actually displays in Google Calendar; the primary
// calendar keeps the literal id "primary" so existing rows retain identity.
async function listSelectedCalendars(accessToken: string): Promise<string[]> {
  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const text = await response.text();
  throwIfRateLimited(response, "Google Calendar", text);
  const payload = parseJson(text);
  if (!response.ok) {
    throw new Error(
      string(payload.error) ?? `Google calendar list failed: HTTP ${response.status}`,
    );
  }
  const items = Array.isArray(payload.items) ? payload.items : [];
  const calendars: string[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as { id?: unknown; selected?: unknown; primary?: unknown };
    const primary = entry.primary === true;
    if (entry.selected !== true && !primary) continue;
    const id = primary ? "primary" : string(entry.id);
    if (id && !calendars.includes(id)) calendars.push(id);
  }
  if (!calendars.includes("primary")) calendars.unshift("primary");
  return calendars;
}

async function syncPage(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  accessToken: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
  pageToken?: string,
): Promise<{
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  nextPageToken?: string;
}> {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  url.searchParams.set("timeMin", new Date(timeMin).toISOString());
  url.searchParams.set("timeMax", new Date(timeMax).toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("maxResults", "250");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  throwIfRateLimited(response, "Google Calendar", text);
  const payload = parseJson(text);
  if (!response.ok) {
    throw new Error(string(payload.error) ?? "Google Calendar request failed");
  }
  const items = Array.isArray(payload.items) ? (payload.items as GoogleEvent[]) : [];
  const events = items.flatMap((event) => parseEvent(event, calendarId) ?? []);
  let created = 0;
  let updated = 0;
  for (let offset = 0; offset < events.length; offset += 100) {
    const result = await ctx.runMutation(internal.capability.integration.upsertGoogleEvents, {
      workspaceId,
      system: true,
      events: events.slice(offset, offset + 100),
    });
    created += result.created;
    updated += result.updated;
  }
  return {
    fetched: items.length,
    created,
    updated,
    skipped: items.length - events.length,
    nextPageToken: string(payload.nextPageToken),
  };
}


export const syncScheduledStep = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const access = await googleAccess(ctx, args.workspaceId);
    const state = args.cursor
      ? (JSON.parse(args.cursor) as {
          calendars: string[];
          index: number;
          pageToken?: string;
          timeMin: string;
          timeMax: string;
        })
      : {
          calendars: await listSelectedCalendars(access.accessToken),
          index: 0,
          timeMin: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
          timeMax: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
        };
    const calendarId = state.calendars[state.index] ?? "primary";
    const result = await syncPage(
      ctx,
      args.workspaceId,
      access.accessToken,
      calendarId,
      state.timeMin,
      state.timeMax,
      state.pageToken,
    );
    const next = result.nextPageToken
      ? { ...state, pageToken: result.nextPageToken }
      : state.index + 1 < state.calendars.length
        ? { ...state, index: state.index + 1, pageToken: undefined }
        : null;
    return {
      done: next === null,
      cursor: next === null ? undefined : JSON.stringify(next),
      fetched: result.fetched,
      applied: result.created + result.updated,
      skipped: result.skipped,
    };
  },
});
