import { randomBytes } from "node:crypto";
import { getProviderConnectionState, getProviderSecret, saveProviderConnection } from "./providers";

const PROVIDER_ID = "google";
const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_CALENDAR_CACHE_TTL_MS = 60_000;
const googleCalendarCache = new Map<
  string,
  { expiresAt: number; payload: { events: Array<GoogleCalendarApiEvent & { calendarId: string }> } }
>();

type GoogleConnectionSettings = {
  configured?: boolean;
  scopes?: string[];
  oauthState?: string;
  returnTo?: string;
  redirectUri?: string;
  accessTokenExpiresAt?: number | null;
};

type TokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type GoogleCalendarApiEvent = {
  id?: string;
  status?: string;
  summary?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
};

type GoogleCalendarListPayload = {
  items?: GoogleCalendarApiEvent[];
  error?: { message?: string };
};

export type GoogleSettings = {
  connected: boolean;
  hasClientConfig: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  scopes: string[];
  canAutoRenew: boolean;
  accessTokenExpiresAt: number | null;
  redirectUri: string | null;
};

export function getGoogleSettings(): GoogleSettings {
  const settings = readSettings();
  const hasClientId = Boolean(getProviderSecret(PROVIDER_ID, "clientId"));
  const hasClientSecret = Boolean(getProviderSecret(PROVIDER_ID, "clientSecret"));
  const hasRefreshToken = Boolean(getProviderSecret(PROVIDER_ID, "refreshToken"));
  return {
    connected: readStatus() === "connected" && hasRefreshToken,
    hasClientConfig: hasClientId && hasClientSecret,
    hasClientId,
    hasClientSecret,
    scopes: settings.scopes ?? DEFAULT_SCOPES,
    canAutoRenew: hasRefreshToken,
    accessTokenExpiresAt: settings.accessTokenExpiresAt ?? null,
    redirectUri: settings.redirectUri ?? null,
  };
}

export function saveGoogleSettings(input: unknown, now = new Date()) {
  if (!isRecord(input)) throw new Error("clientId and clientSecret are required");
  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  const clientSecret =
    typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
  if (!clientId || !clientSecret) {
    throw new Error("clientId and clientSecret are required");
  }
  const settings = readSettings();
  saveProviderConnection(
    PROVIDER_ID,
    {
      settings: { ...settings, configured: true },
      secrets: { clientId, clientSecret },
    },
    settings.accessTokenExpiresAt ? "connected" : "available",
    now,
  );
  return getGoogleSettings();
}


export function startGoogleAuth(input: unknown, requestOrigin: string, now = new Date()) {
  const clientId = getProviderSecret(PROVIDER_ID, "clientId");
  const clientSecret = getProviderSecret(PROVIDER_ID, "clientSecret");
  if (!clientId || !clientSecret) throw new Error("Google OAuth client is not configured");
  const body = isRecord(input) ? input : {};
  const scopes = parseScopes(body.scopes);
  const returnTo =
    typeof body.returnTo === "string" && body.returnTo.trim()
      ? body.returnTo.trim()
      : "http://localhost:3000/life";
  const state = randomBytes(24).toString("base64url");
  const redirectUri = `${requestOrigin}/v1/integrations/google/auth/callback`;
  saveProviderConnection(
    PROVIDER_ID,
    {
      settings: {
        ...readSettings(),
        configured: true,
        scopes,
        oauthState: state,
        returnTo,
        redirectUri,
      },
    },
    "pending",
    now,
  );
  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return { authUrl: `${GOOGLE_AUTH_URL}?${authParams.toString()}`, state, scopes };
}

export async function finishGoogleAuth(input: {
  code: string | null;
  state: string | null;
}) {
  const settings = readSettings();
  if (!input.code) throw new Error("Missing Google OAuth code");
  if (!input.state || input.state !== settings.oauthState) {
    throw new Error("Invalid Google OAuth state");
  }
  const clientId = getProviderSecret(PROVIDER_ID, "clientId");
  const clientSecret = getProviderSecret(PROVIDER_ID, "clientSecret");
  if (!clientId || !clientSecret || !settings.redirectUri) {
    throw new Error("Google OAuth client is not configured");
  }
  const token = await requestToken({
    grant_type: "authorization_code",
    code: input.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: settings.redirectUri,
  });
  const expiresAt = Date.now() + Math.max(0, token.expires_in ?? 3600) * 1000;
  const secrets: Record<string, string> = {};
  if (token.access_token) secrets.accessToken = token.access_token;
  if (token.refresh_token) secrets.refreshToken = token.refresh_token;
  if (!token.refresh_token && !getProviderSecret(PROVIDER_ID, "refreshToken")) {
    throw new Error("Google did not return a refresh token. Reconnect with consent prompt.");
  }
  saveProviderConnection(
    PROVIDER_ID,
    {
      settings: {
        configured: true,
        scopes: token.scope?.split(/\s+/).filter(Boolean) ?? settings.scopes ?? DEFAULT_SCOPES,
        returnTo: settings.returnTo,
        redirectUri: settings.redirectUri,
        accessTokenExpiresAt: expiresAt,
      },
      secrets,
    },
    "connected",
  );
  return { returnTo: settings.returnTo ?? "http://localhost:3000/life" };
}

export async function listGoogleCalendarEvents(input: {
  timeMin?: string;
  timeMax?: string;
  maxResults?: string;
}) {
  const cacheKey = JSON.stringify(input);
  const cached = googleCalendarCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;
  const accessToken = await getUsableAccessToken();
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: input.maxResults ?? "250",
  });
  if (input.timeMin) params.set("timeMin", input.timeMin);
  if (input.timeMax) params.set("timeMax", input.timeMax);
  const response = await fetch(`${GOOGLE_CALENDAR_EVENTS_URL}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json().catch(() => ({}))) as GoogleCalendarListPayload;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "Google Calendar request failed");
  }
  const result = {
    events: (payload.items ?? []).map((event) => ({
      ...event,
      calendarId: "primary",
    })),
  };
  googleCalendarCache.set(cacheKey, {
    expiresAt: Date.now() + GOOGLE_CALENDAR_CACHE_TTL_MS,
    payload: result,
  });
  return result;
}

async function getUsableAccessToken() {
  const settings = readSettings();
  const current = getProviderSecret(PROVIDER_ID, "accessToken");
  if (current && (settings.accessTokenExpiresAt ?? 0) > Date.now() + 60_000) {
    return current;
  }
  const refreshToken = getProviderSecret(PROVIDER_ID, "refreshToken");
  const clientId = getProviderSecret(PROVIDER_ID, "clientId");
  const clientSecret = getProviderSecret(PROVIDER_ID, "clientSecret");
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("Google Calendar is not connected");
  }
  const token = await requestToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (!token.access_token) throw new Error("Google did not return an access token");
  const expiresAt = Date.now() + Math.max(0, token.expires_in ?? 3600) * 1000;
  saveProviderConnection(
    PROVIDER_ID,
    {
      settings: { ...settings, accessTokenExpiresAt: expiresAt },
      secrets: { accessToken: token.access_token },
    },
    "connected",
  );
  return token.access_token;
}

async function requestToken(params: Record<string, string>) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as TokenPayload;
  if (!response.ok || payload.error) {
    throw new Error(payload.error_description ?? payload.error ?? "Google token request failed");
  }
  return payload;
}

function readSettings(): GoogleConnectionSettings {
  const raw = getProviderConnectionState(PROVIDER_ID)?.settingsJson ?? "{}";
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readStatus() {
  return getProviderConnectionState(PROVIDER_ID)?.status ?? "available";
}

function parseScopes(value: unknown) {
  if (!Array.isArray(value)) return DEFAULT_SCOPES;
  const scopes = value.filter((scope): scope is string => typeof scope === "string" && !!scope.trim());
  return scopes.length ? scopes : DEFAULT_SCOPES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
