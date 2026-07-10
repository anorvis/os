import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase, resetDatabaseForTests } from "../src/core/db/database";
import { createApp, type App } from "../src/platform/gateway/app";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

const CLIENT_ID = "google-client-id-1234567890.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-super-secret-client-value";
const ACCESS_TOKEN = "ya29.mock-access-token-abcdef";
const REFRESH_TOKEN = "1//mock-refresh-token-xyz";

const API_TOKEN = "test-api-token-1234567890";
type GoogleSettingsResponse = {
  connected: boolean;
  hasClientConfig: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  scopes: string[];
  canAutoRenew: boolean;
  accessTokenExpiresAt: number | null;
  redirectUri: string | null;
};

type AuthStartResponse = { authUrl: string; state: string; scopes: string[] };

type ConnectionRow = {
  status: string;
  settings_json: string;
  secret_refs_json: string;
};

type FetchHandlers = {
  token?: (body: string) => { status?: number; payload: unknown };
  calendar?: (url: string) => { status?: number; payload: unknown };
};

type FetchLog = { tokenBodies: string[]; calendarUrls: string[] };

function googleConnection(): ConnectionRow | null {
  return (
    getDatabase()
      .query<ConnectionRow, [string]>(
        "SELECT status, settings_json, secret_refs_json FROM provider_connections WHERE provider_id = ?1",
      )
      .get("google") ?? null
  );
}

function withFakeGoogleFetch(handlers: FetchHandlers): {
  log: FetchLog;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const log: FetchLog = { tokenBodies: [], calendarUrls: [] };
  globalThis.fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.startsWith(GOOGLE_TOKEN_URL)) {
      const body = typeof init?.body === "string" ? init.body : "";
      log.tokenBodies.push(body);
      if (!handlers.token)
        return Promise.reject(new Error(`unexpected token fetch: ${url}`));
      const { status = 200, payload } = handlers.token(body);
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.startsWith(GOOGLE_CALENDAR_EVENTS_URL)) {
      log.calendarUrls.push(url);
      if (!handlers.calendar)
        return Promise.reject(new Error(`unexpected calendar fetch: ${url}`));
      const { status = 200, payload } = handlers.calendar(url);
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected network fetch in test: ${url}`));
  }) as typeof fetch;
  return { log, restore: () => void (globalThis.fetch = original) };
}

async function saveClientConfig(app: App): Promise<Response> {
  return app.request("/v1/integrations/google/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
  });
}

async function startAuth(app: App): Promise<AuthStartResponse> {
  const response = await app.request("/v1/integrations/google/auth/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as AuthStartResponse;
}

const OK_TOKEN = {
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  expires_in: 3600,
  scope: "https://www.googleapis.com/auth/calendar.readonly",
  token_type: "Bearer",
};

async function connectGoogle(app: App): Promise<void> {
  const saved = await saveClientConfig(app);
  expect(saved.status).toBe(200);
  const { state } = await startAuth(app);
  const fake = withFakeGoogleFetch({ token: () => ({ payload: OK_TOKEN }) });
  try {
    const callback = await app.request(
      `/v1/integrations/google/auth/callback?code=auth-code-abc&state=${encodeURIComponent(state)}`,
    );
    expect(callback.status).toBe(302);
  } finally {
    fake.restore();
  }
}

async function withIsolatedGateway(run: (app: App) => Promise<void>): Promise<void> {
  const environment = captureEnvironment(
    "HOME",
    "ANORVIS_DB_PATH",
    "ANORVIS_OS_API_TOKEN",
    "ANORVIS_OS_API_TOKEN_PATH",
    "ANORVIS_SECRET_PROVIDER",
    "ANORVIS_SECRET_KEY_PATH",
  );
  const home = mkdtempSync(join(tmpdir(), "anorvis-google-"));
  process.env.HOME = home;
  process.env.ANORVIS_DB_PATH = join(home, "anorvis.sqlite");
  process.env.ANORVIS_OS_API_TOKEN_PATH = join(home, "missing-token");
  delete process.env.ANORVIS_OS_API_TOKEN;
  process.env.ANORVIS_SECRET_PROVIDER = "local";
  delete process.env.ANORVIS_SECRET_KEY_PATH;
  resetDatabaseForTests();
  try {
    await run(createApp());
  } finally {
    resetDatabaseForTests();
    restoreEnvironment(environment);
  }
}

function captureEnvironment(...keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(environment: Map<string, string | undefined>): void {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("Google integration gateway contracts", () => {
  test("saving client config stores opaque secrets and does not mark google connected", async () => {
    await withIsolatedGateway(async (app) => {
      const response = await saveClientConfig(app);
      expect(response.status).toBe(200);
      const settings = (await response.json()) as GoogleSettingsResponse;

      expect(settings.hasClientConfig).toBe(true);
      expect(settings.hasClientId).toBe(true);
      expect(settings.hasClientSecret).toBe(true);
      // Providing credentials must not imply an authorized (connected) account.
      expect(settings.connected).toBe(false);
      expect(settings.canAutoRenew).toBe(false);
      expect(settings.accessTokenExpiresAt).toBeNull();

      const row = googleConnection();
      expect(row?.status).toBe("available");
      const refs = JSON.parse(row?.secret_refs_json ?? "{}") as Record<string, string>;
      expect(refs.clientId?.startsWith("secret:")).toBe(true);
      expect(refs.clientSecret?.startsWith("secret:")).toBe(true);
      // Raw credentials must never be persisted in the connection row.
      expect(row?.secret_refs_json ?? "").not.toContain(CLIENT_ID);
      expect(row?.secret_refs_json ?? "").not.toContain(CLIENT_SECRET);
      expect(row?.settings_json ?? "").not.toContain(CLIENT_ID);
      expect(row?.settings_json ?? "").not.toContain(CLIENT_SECRET);

      // The public settings view must not leak the raw client secret either.
      const view = await app.request("/v1/integrations/google/settings");
      const viewText = await view.text();
      expect(viewText).not.toContain(CLIENT_SECRET);
    });
  });

  test("rejects blank client credentials without creating a google connection", async () => {
    await withIsolatedGateway(async (app) => {
      const response = await app.request("/v1/integrations/google/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "  ", clientSecret: "" }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "clientId and clientSecret are required",
      });
      expect(googleConnection()).toBeNull();
    });
  });

  test("auth start returns the Google consent URL and marks the connection pending", async () => {
    await withIsolatedGateway(async (app) => {
      await saveClientConfig(app);
      const auth = await startAuth(app);

      const authUrl = new URL(auth.authUrl);
      expect(`${authUrl.origin}${authUrl.pathname}`).toBe(GOOGLE_AUTH_URL);
      expect(authUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(authUrl.searchParams.get("response_type")).toBe("code");
      expect(authUrl.searchParams.get("access_type")).toBe("offline");
      expect(authUrl.searchParams.get("prompt")).toBe("consent");
      expect(authUrl.searchParams.get("redirect_uri")).toBe(
        "http://127.0.0.1/v1/integrations/google/auth/callback",
      );
      expect(authUrl.searchParams.get("state")).toBe(auth.state);
      expect(auth.state.length).toBeGreaterThan(0);
      expect(authUrl.searchParams.get("scope")).toBe(auth.scopes.join(" "));

      expect(googleConnection()?.status).toBe("pending");
    });
  });

  test("auth start is refused until the OAuth client is configured", async () => {
    await withIsolatedGateway(async (app) => {
      const response = await app.request("/v1/integrations/google/auth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Google OAuth client is not configured",
      });
      expect(googleConnection()).toBeNull();
    });
  });

  test("callback exchanges the code for tokens, marks connected, and stores no plaintext secrets", async () => {
    await withIsolatedGateway(async (app) => {
      await saveClientConfig(app);
      const { state } = await startAuth(app);

      const fake = withFakeGoogleFetch({ token: () => ({ payload: OK_TOKEN }) });
      try {
        const callback = await app.request(
          `/v1/integrations/google/auth/callback?code=auth-code-abc&state=${encodeURIComponent(state)}`,
        );
        expect(callback.status).toBe(302);
        expect(callback.headers.get("location")).toBe("http://localhost:3000/life");

        // The exchange must POST the authorization_code grant to Google's token endpoint.
        expect(fake.log.tokenBodies).toHaveLength(1);
        const tokenBody = new URLSearchParams(fake.log.tokenBodies[0]);
        expect(tokenBody.get("grant_type")).toBe("authorization_code");
        expect(tokenBody.get("code")).toBe("auth-code-abc");
        expect(tokenBody.get("redirect_uri")).toBe(
          "http://127.0.0.1/v1/integrations/google/auth/callback",
        );
      } finally {
        fake.restore();
      }

      const view = await app.request("/v1/integrations/google/settings");
      const settings = (await view.json()) as GoogleSettingsResponse;
      expect(settings.connected).toBe(true);
      expect(settings.canAutoRenew).toBe(true);
      expect(typeof settings.accessTokenExpiresAt).toBe("number");

      const row = googleConnection();
      expect(row?.status).toBe("connected");
      const refs = JSON.parse(row?.secret_refs_json ?? "{}") as Record<string, string>;
      expect(refs.accessToken?.startsWith("secret:")).toBe(true);
      expect(refs.refreshToken?.startsWith("secret:")).toBe(true);
      // Tokens must be stored behind opaque refs, never inline in the row or public view.
      const combined = `${row?.settings_json ?? ""}${row?.secret_refs_json ?? ""}`;
      expect(combined).not.toContain(ACCESS_TOKEN);
      expect(combined).not.toContain(REFRESH_TOKEN);
      const viewText = JSON.stringify(settings);
      expect(viewText).not.toContain(ACCESS_TOKEN);
      expect(viewText).not.toContain(REFRESH_TOKEN);
    });
  });

  test("callback accepts Google redirect without gateway bearer token", async () => {
    await withIsolatedGateway(async (app) => {
      process.env.ANORVIS_OS_API_TOKEN = API_TOKEN;
      const authHeaders = {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json",
      };

      const saved = await app.request("/v1/integrations/google/settings", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
      });
      expect(saved.status).toBe(200);

      const started = await app.request("/v1/integrations/google/auth/start", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      expect(started.status).toBe(200);
      const { state } = (await started.json()) as AuthStartResponse;

      const protectedStatus = await app.request("/v1/integrations/google/status");
      expect(protectedStatus.status).toBe(401);

      const fake = withFakeGoogleFetch({ token: () => ({ payload: OK_TOKEN }) });
      try {
        const callback = await app.request(
          `/v1/integrations/google/auth/callback?code=auth-code-abc&state=${encodeURIComponent(state)}`,
        );
        expect(callback.status).toBe(302);
        expect(callback.headers.get("location")).toBe("http://localhost:3000/life");
      } finally {
        fake.restore();
      }

      const connected = await app.request("/v1/integrations/google/status", {
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(connected.status).toBe(200);
      expect(((await connected.json()) as GoogleSettingsResponse).connected).toBe(true);
    });
  });

  test("callback rejects a mismatched OAuth state without contacting Google", async () => {
    await withIsolatedGateway(async (app) => {
      await saveClientConfig(app);
      await startAuth(app);

      const fake = withFakeGoogleFetch({
        token: () => ({ payload: OK_TOKEN }),
      });
      try {
        const callback = await app.request(
          "/v1/integrations/google/auth/callback?code=auth-code-abc&state=forged-state",
        );
        expect(callback.status).toBe(400);
        expect(await callback.json()).toEqual({ error: "Invalid Google OAuth state" });
        // State is validated before any token exchange happens.
        expect(fake.log.tokenBodies).toHaveLength(0);
      } finally {
        fake.restore();
      }

      const settings = (await (
        await app.request("/v1/integrations/google/settings")
      ).json()) as GoogleSettingsResponse;
      expect(settings.connected).toBe(false);
    });
  });

  test("callback rejects a missing OAuth code", async () => {
    await withIsolatedGateway(async (app) => {
      await saveClientConfig(app);
      const { state } = await startAuth(app);
      const callback = await app.request(
        `/v1/integrations/google/auth/callback?state=${encodeURIComponent(state)}`,
      );
      expect(callback.status).toBe(400);
      expect(await callback.json()).toEqual({ error: "Missing Google OAuth code" });
    });
  });

  test("google calendar route maps events and serves repeat requests from cache", async () => {
    await withIsolatedGateway(async (app) => {
      await connectGoogle(app);

      const fake = withFakeGoogleFetch({
        token: () => ({ payload: OK_TOKEN }),
        calendar: () => ({
          payload: {
            items: [
              {
                id: "evt-cache",
                status: "confirmed",
                summary: "Standup",
                start: { dateTime: "2032-06-02T09:00:00.000Z" },
                end: { dateTime: "2032-06-02T09:30:00.000Z" },
              },
            ],
          },
        }),
      });
      try {
        const query = "timeMin=2032-06-01T00:00:00.000Z";
        const first = await app.request(
          `/v1/integrations/google/calendar/events?${query}`,
        );
        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as {
          events: Array<{ id?: string; calendarId?: string; summary?: string }>;
        };
        expect(firstBody.events).toHaveLength(1);
        expect(firstBody.events[0]).toMatchObject({
          id: "evt-cache",
          calendarId: "primary",
          summary: "Standup",
        });

        const second = await app.request(
          `/v1/integrations/google/calendar/events?${query}`,
        );
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual(firstBody);

        // A cache hit means Google is contacted exactly once across both requests.
        expect(fake.log.calendarUrls).toHaveLength(1);
        // A valid stored access token avoids a refresh round-trip.
        expect(fake.log.tokenBodies).toHaveLength(0);
      } finally {
        fake.restore();
      }
    });
  });

  test("aggregate calendar route folds Google events into /v1/calendar/events and drops cancelled ones", async () => {
    await withIsolatedGateway(async (app) => {
      await connectGoogle(app);

      const fake = withFakeGoogleFetch({
        token: () => ({ payload: OK_TOKEN }),
        calendar: () => ({
          payload: {
            items: [
              {
                id: "timed-1",
                status: "confirmed",
                summary: "Design review",
                start: { dateTime: "2031-03-02T15:00:00.000Z" },
                end: { dateTime: "2031-03-02T16:00:00.000Z" },
              },
              {
                id: "allday-1",
                summary: "Company holiday",
                start: { date: "2031-03-05" },
                end: { date: "2031-03-06" },
              },
              {
                id: "cancelled-1",
                status: "cancelled",
                summary: "Scrapped sync",
                start: { dateTime: "2031-03-03T12:00:00.000Z" },
                end: { dateTime: "2031-03-03T12:30:00.000Z" },
              },
            ],
          },
        }),
      });
      try {
        const response = await app.request(
          "/v1/calendar/events?timeMin=2031-03-01T00:00:00.000Z&timeMax=2031-03-31T00:00:00.000Z",
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          items: Array<{
            id: string;
            summary: string;
            source?: string;
            readOnly?: boolean;
            tag?: string;
            allDay?: boolean;
          }>;
        };

        const ids = body.items.map((item) => item.id);
        expect(ids).toContain("google:primary:timed-1");
        expect(ids).toContain("google:primary:allday-1");
        expect(ids).not.toContain("google:primary:cancelled-1");

        const timed = body.items.find((item) => item.id === "google:primary:timed-1");
        expect(timed).toMatchObject({
          summary: "Design review",
          source: "google-calendar",
          readOnly: true,
          tag: "google calendar",
          allDay: false,
        });

        const allDay = body.items.find((item) => item.id === "google:primary:allday-1");
        expect(allDay?.allDay).toBe(true);
      } finally {
        fake.restore();
      }
    });
  });

  test("aggregate calendar route omits Google events when providers are excluded", async () => {
    await withIsolatedGateway(async (app) => {
      await connectGoogle(app);

      const fake = withFakeGoogleFetch({
        calendar: () => {
          throw new Error("provider fetch should be skipped when includeProviders=false");
        },
      });
      try {
        const response = await app.request(
          "/v1/calendar/events?includeProviders=false&timeMin=2033-01-01T00:00:00.000Z&timeMax=2033-01-31T00:00:00.000Z",
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { items: unknown[] };
        expect(body.items).toEqual([]);
        expect(fake.log.calendarUrls).toHaveLength(0);
      } finally {
        fake.restore();
      }
    });
  });
});
