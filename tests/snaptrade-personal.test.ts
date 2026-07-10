import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase, resetDatabaseForTests } from "../src/core/db/database";
import {
  getFinanceDashboard,
  upsertFinanceActivity,
} from "../src/capability/finance/data";
import { createApp } from "../src/platform/gateway/app";
import {
  setSnapTradeFetch,
  snapTradeSignature,
} from "../src/capability/finance/snaptrade";

type GatewayApp = {
  request(input: string | Request, init?: RequestInit): Promise<Response>;
};

// Distinctive, hyphenated credential values so substring assertions ("never on the wire")
// cannot collide with base64 signature bytes or unrelated request fields.
const CLIENT_ID = "snaptrade-client-1234";
const CONSUMER_KEY = "consumer-hmac-key-ABCDEF";

async function withIsolatedGateway(
  run: (app: GatewayApp) => Promise<void>,
): Promise<void> {
  const oldHome = process.env.HOME;
  const oldToken = process.env.ANORVIS_OS_API_TOKEN;
  const oldDbPath = process.env.ANORVIS_DB_PATH;
  const oldSecretProvider = process.env.ANORVIS_SECRET_PROVIDER;
  const oldSecretKeyPath = process.env.ANORVIS_SECRET_KEY_PATH;
  process.env.HOME = mkdtempSync(join(tmpdir(), "anorvis-snaptrade-"));
  delete process.env.ANORVIS_OS_API_TOKEN;
  delete process.env.ANORVIS_DB_PATH;
  process.env.ANORVIS_SECRET_PROVIDER = "local";
  delete process.env.ANORVIS_SECRET_KEY_PATH;
  resetDatabaseForTests();

  try {
    await run(createApp());
  } finally {
    setSnapTradeFetch(null);
    resetDatabaseForTests();
    process.env.HOME = oldHome;
    if (oldToken === undefined) delete process.env.ANORVIS_OS_API_TOKEN;
    else process.env.ANORVIS_OS_API_TOKEN = oldToken;
    if (oldDbPath === undefined) delete process.env.ANORVIS_DB_PATH;
    else process.env.ANORVIS_DB_PATH = oldDbPath;
    if (oldSecretProvider === undefined)
      delete process.env.ANORVIS_SECRET_PROVIDER;
    else process.env.ANORVIS_SECRET_PROVIDER = oldSecretProvider;
    if (oldSecretKeyPath === undefined)
      delete process.env.ANORVIS_SECRET_KEY_PATH;
    else process.env.ANORVIS_SECRET_KEY_PATH = oldSecretKeyPath;
  }
}

type CapturedRequest = {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

type SnapTradeResponse = { status?: number; payload: unknown };

// Injects the module's transport double (setSnapTradeFetch) — the adapter's documented test
// hook — and captures the exact signed URL/headers/body of every request without any network.
function withFakeSnapTradeFetch(
  handler: (request: { path: string; method: string }) => SnapTradeResponse,
): { requests: CapturedRequest[]; restore: () => void } {
  const requests: CapturedRequest[] = [];
  setSnapTradeFetch((url, init) => {
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const path = parsed.pathname.replace(/^\/api\/v1/, "");
    const captured: CapturedRequest = {
      url,
      path,
      method: String(init.method ?? "GET"),
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
    };
    requests.push(captured);
    const { status = 200, payload } = handler({
      path,
      method: captured.method,
    });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return { requests, restore: () => setSnapTradeFetch(null) };
}

async function saveCredentials(app: GatewayApp): Promise<void> {
  const response = await app.request("/v1/integrations/snaptrade/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT_ID, consumerKey: CONSUMER_KEY }),
  });
  expect(response.status).toBe(200);
}

// One brokerage account whose reported balance currency (USD) differs from a held position's
// listing currency (CAD), so the canonical store must keep the two currencies separate.
const SNAPTRADE_ACCOUNT = {
  id: "acc-1",
  name: "Brokerage RRSP",
  institution_name: "Questrade",
  number: "12345678",
  account_category: "INVESTMENT",
  status: "ACTIVE",
  balance: { total: { currency: "USD", amount: 15000.5 } },
};
const SNAPTRADE_WEALTHSIMPLE_MSB_ACCOUNT = {
  id: "acc-wealthsimple-msb",
  name: "Wealthsimple Trade MSB",
  institution_name: "Wealthsimple",
  number: "987654321",
  raw_type: "MSB",
  status: "ACTIVE",
  balance: { total: { currency: "CAD", amount: 742.13 } },
};
const SNAPTRADE_WEALTHSIMPLE_BALANCES = [
  { currency: { code: "CAD" }, cash: 742.13, buying_power: null },
];
const SNAPTRADE_WEALTHSIMPLE_SPEND_ACTIVITIES = {
  data: [
    {
      id: "act-wealthsimple-spend-1",
      type: "SPEND",
      trade_date: "2026-06-12",
      settlement_date: "2026-06-12",
      currency: { code: "CAD" },
      amount: 42.5,
      units: 0,
      price: 0,
      description: "Wealthsimple card purchase",
    },
  ],
  pagination: { total: 1 },
};
const SNAPTRADE_WEALTHSIMPLE_SPEND_REVERSAL_ACTIVITIES = {
  data: [
    {
      id: "act-wealthsimple-spend-reversal-1",
      type: "SPEND",
      trade_date: "2026-06-14",
      settlement_date: "2026-06-14",
      currency: { code: "CAD" },
      amount: -12.34,
      units: 0,
      price: 0,
      description: "Wealthsimple card refund",
    },
  ],
  pagination: { total: 1 },
};
const SNAPTRADE_WEALTHSIMPLE_SECURITY_SHAPED_SPEND_ACTIVITIES = {
  data: [
    {
      id: "act-wealthsimple-security-spend-1",
      type: "SPEND",
      trade_date: "2026-06-13",
      settlement_date: "2026-06-13",
      currency: { code: "CAD" },
      amount: 27.75,
      units: 0,
      price: 0,
      symbol: { symbol: "CASH" },
      description: "Security-shaped card spend",
    },
  ],
  pagination: { total: 1 },
};
const SNAPTRADE_BALANCES = [
  { currency: { code: "USD" }, cash: 2500.25, buying_power: 5000 },
];
const SNAPTRADE_HISTORY = {
  currency: "USD",
  history: [
    { date: "2026-05-31", total_value: 14000.25 },
    { date: "2026-06-30", total_value: 14800.75 },
  ],
};
const SNAPTRADE_RETURN_RATES = {
  data: [
    {
      timeframe: "1M",
      return_percent: -2.5,
      created_date: "2026-06-30",
    },
    {
      timeframe: "YTD",
      return_percent: 7.25,
      created_date: "2026-06-30",
    },
  ],
};
const SNAPTRADE_POSITIONS = {
  results: [
    {
      instrument: {
        symbol: "AAPL",
        currency: "USD",
        id: "sec-aapl",
        description: "Apple Inc.",
      },
      units: 10,
      price: 190.5,
      cost_basis: 150.25,
    },
    {
      instrument: {
        symbol: "SHOP",
        currency: "CAD",
        id: "sec-shop",
        description: "Shopify Inc.",
      },
      units: 5,
      price: 100,
      cost_basis: 80,
    },
  ],
};
const SNAPTRADE_ACTIVITIES = {
  data: [
    {
      id: "act-1",
      type: "BUY",
      trade_date: "2026-06-01",
      settlement_date: "2026-06-03",
      currency: { code: "USD" },
      amount: -1905,
      units: 10,
      price: 190.5,
      symbol: { symbol: "AAPL" },
      description: "Bought AAPL",
    },
  ],
  pagination: { total: 1 },
};
const SNAPTRADE_BROKERAGE_BUY_SELL_ACTIVITIES = {
  data: [
    {
      id: "act-brokerage-buy-1",
      type: "BUY",
      trade_date: "2026-06-01",
      settlement_date: "2026-06-03",
      currency: { code: "USD" },
      amount: -1905,
      units: 10,
      price: 190.5,
      symbol: { symbol: "AAPL" },
      description: "Bought AAPL",
    },
    {
      id: "act-brokerage-sell-1",
      type: "SELL",
      trade_date: "2026-06-07",
      settlement_date: "2026-06-09",
      currency: { code: "USD" },
      amount: 1010,
      units: 5,
      price: 202,
      symbol: { symbol: "MSFT" },
      description: "Sold MSFT",
    },
  ],
  pagination: { total: 2 },
};

type DashboardAccount = {
  id: string;
  source: string;
  sourceId: string | null;
  sourceVariant: string | null;
  name: string;
  type: string;
  currency: string;
  balance: number | null;
  institution: string | null;
  mask: string | null;
  status: string | null;
};
type DashboardBalance = {
  accountId: string;
  currency: string;
  cash: number | null;
  buyingPower: number | null;
  source: string;
};
type DashboardPosition = {
  accountId: string | null;
  symbol: string;
  source: string;
  currency: string;
  quantity: number;
  marketValue: number | null;
  averageCost: number | null;
  name: string | null;
};
type DashboardTransaction = {
  accountId: string | null;
  source: string;
  sourceVariant: string | null;
  description: string;
  amount: number;
  currency: string;
  postedAt: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryGroup: string | null;
  status: string;
};
type DashboardActivity = {
  accountId: string | null;
  source: string;
  type: string;
  currency: string;
  symbol: string | null;
  amount: number | null;
  quantity: number | null;
  price: number | null;
  status: string;
};
type DashboardHistory = {
  accountId: string | null;
  date: string;
  equity: number;
  cash: number | null;
  currency: string;
  source: string;
};
type DashboardReturnRate = {
  accountId: string;
  source: string;
  sourceVariant: string | null;
  timeframe: string;
  returnPercent: number;
  asOf: string | null;
};
type Dashboard = {
  accounts: DashboardAccount[];
  balances: DashboardBalance[];
  transactions: DashboardTransaction[];
  positions: DashboardPosition[];
  activities: DashboardActivity[];
  history: DashboardHistory[];
  returnRates: DashboardReturnRate[];
  byCurrency: Array<{
    currency: string;
    accounts: DashboardAccount[];
    balances: DashboardBalance[];
    transactions: DashboardTransaction[];
    positions: DashboardPosition[];
    activities: DashboardActivity[];
  }>;
};

type SyncSummary = {
  ok: boolean;
  accounts: number;
  balances: number;
  positions: number;
  activities: number;
  activitiesInserted: number;
  activitiesSkipped: number;
  transactions: number;
  transactionsInserted: number;
  transactionsSkipped: number;
  accountsLinked: number;
  historyPoints: number;
  returnRates: number;
  warnings: string[];
};

describe("SnapTrade Personal request signing and authentication", () => {
  test("signs the connection portal request with clientId + timestamp + HMAC Signature and never transmits userId, userSecret, or the consumerKey", async () => {
    await withIsolatedGateway(async (app) => {
      await saveCredentials(app);
      const fake = withFakeSnapTradeFetch(() => ({
        payload: {
          redirectURI: "https://app.snaptrade.com/connect/abc",
          sessionId: "sess-1",
        },
      }));
      try {
        const response = await app.request(
          "/v1/integrations/snaptrade/portal",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          redirectUri: "https://app.snaptrade.com/connect/abc",
          sessionId: "sess-1",
        });
      } finally {
        fake.restore();
      }

      expect(fake.requests).toHaveLength(1);
      const request = fake.requests[0];
      expect(request.method).toBe("POST");
      const url = new URL(request.url);
      expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
        "https://api.snaptrade.com/api/v1/snapTrade/login",
      );

      // Personal Authentication puts only clientId + timestamp on the wire.
      const rawQuery = request.url.slice(request.url.indexOf("?") + 1);
      const query = new URLSearchParams(rawQuery);
      expect(query.get("clientId")).toBe(CLIENT_ID);
      expect(query.get("timestamp")).toMatch(/^\d+$/);

      // The stale OpenAPI userId/userSecret params are deliberately omitted, and the consumerKey
      // is only ever the HMAC key — it must never appear on the wire.
      const wire = `${request.url}\n${JSON.stringify(request.headers)}\n${request.body ?? ""}`;
      expect(wire.toLowerCase()).not.toContain("userid");
      expect(wire.toLowerCase()).not.toContain("usersecret");
      expect(wire).not.toContain(CONSUMER_KEY);

      // The Signature header is a genuine HMAC-SHA256 over the canonical {content, path, query}.
      const content =
        request.body === undefined
          ? null
          : (JSON.parse(request.body) as Record<string, unknown>);
      const expectedSignature = snapTradeSignature({
        content,
        path: url.pathname,
        query: rawQuery,
        consumerKey: CONSUMER_KEY,
      });
      expect(request.headers.signature).toBe(expectedSignature);
      expect(expectedSignature.length).toBeGreaterThan(0);

      // The portal is hardcoded read-only in the signed body.
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      expect(body.connectionType).toBe("read");
    });
  });

  test("rejects sync and portal with not_connected and issues no network request until clientId + consumerKey are saved", async () => {
    await withIsolatedGateway(async (app) => {
      const guard = withFakeSnapTradeFetch(() => {
        throw new Error(
          "SnapTrade must not hit the network before credentials are saved",
        );
      });
      try {
        const sync = await app.request("/v1/integrations/snaptrade/sync", {
          method: "POST",
        });
        expect(sync.status).toBe(409);
        expect(await sync.json()).toEqual({
          error:
            "SnapTrade is not connected: save clientId and consumerKey first",
          code: "not_connected",
        });

        const portal = await app.request("/v1/integrations/snaptrade/portal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(portal.status).toBe(409);
        expect(((await portal.json()) as { code: string }).code).toBe(
          "not_connected",
        );

        expect(guard.requests).toHaveLength(0);
      } finally {
        guard.restore();
      }
    });
  });

  test("requires both clientId and consumerKey and never returns or persists the raw secret values", async () => {
    await withIsolatedGateway(async (app) => {
      const missing = await app.request("/v1/integrations/snaptrade/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: CLIENT_ID }),
      });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({
        error: "clientId and consumerKey are required",
        code: "invalid_settings",
      });

      const saved = await app.request("/v1/integrations/snaptrade/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: CLIENT_ID,
          consumerKey: CONSUMER_KEY,
        }),
      });
      expect(saved.status).toBe(200);
      const savedText = await saved.text();
      const settings = JSON.parse(savedText) as {
        connected: boolean;
        hasClientId: boolean;
        hasConsumerKey: boolean;
      };
      expect(settings.connected).toBe(true);
      expect(settings.hasClientId).toBe(true);
      expect(settings.hasConsumerKey).toBe(true);
      // The response exposes booleans only — never the raw secret material.
      expect(savedText).not.toContain(CLIENT_ID);
      expect(savedText).not.toContain(CONSUMER_KEY);

      // Neither secret is persisted in plaintext in the provider connection metadata.
      const row = getDatabase()
        .query<
          { settings_json: string | null; secret_refs_json: string | null },
          []
        >(
          "SELECT settings_json, secret_refs_json FROM provider_connections WHERE provider_id = 'snaptrade'",
        )
        .get();
      expect(row?.settings_json ?? "").not.toContain(CLIENT_ID);
      expect(row?.settings_json ?? "").not.toContain(CONSUMER_KEY);
      expect(row?.secret_refs_json ?? "").not.toContain(CLIENT_ID);
      expect(row?.secret_refs_json ?? "").not.toContain(CONSUMER_KEY);
    });
  });

  test("locks the connection portal to read-only and rejects a caller-supplied trade connectionType before any network call", async () => {
    await withIsolatedGateway(async (app) => {
      await saveCredentials(app);
      const guard = withFakeSnapTradeFetch(() => {
        throw new Error(
          "a locked connectionType must be rejected before any network call",
        );
      });
      try {
        const response = await app.request(
          "/v1/integrations/snaptrade/portal",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ connectionType: "trade" }),
          },
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "connectionType is locked to 'read' for this integration",
          code: "connection_type_locked",
        });
        expect(guard.requests).toHaveLength(0);
      } finally {
        guard.restore();
      }
    });
  });
});

describe("SnapTrade Personal read-only sync", () => {
  test("fetches only read-only GET endpoints, signs each with null content, and normalizes accounts/balances/history/return rates/positions/activities into canonical rows", async () => {
    await withIsolatedGateway(async (app) => {
      await saveCredentials(app);
      const fake = withFakeSnapTradeFetch(({ path }) => {
        if (path === "/accounts") return { payload: [SNAPTRADE_ACCOUNT] };
        if (path === "/accounts/acc-1/balances")
          return { payload: SNAPTRADE_BALANCES };
        if (path === "/accounts/acc-1/balanceHistory")
          return { payload: SNAPTRADE_HISTORY };
        if (path === "/accounts/acc-1/returnRates")
          return { payload: SNAPTRADE_RETURN_RATES };
        if (path === "/accounts/acc-1/positions/all")
          return { payload: SNAPTRADE_POSITIONS };
        if (path === "/accounts/acc-1/activities")
          return { payload: SNAPTRADE_ACTIVITIES };
        throw new Error(`unexpected SnapTrade path: ${path}`);
      });
      try {
        const syncResponse = await app.request(
          "/v1/integrations/snaptrade/sync",
          {
            method: "POST",
          },
        );
        expect(syncResponse.status).toBe(200);
        const summary = (await syncResponse.json()) as SyncSummary;
        expect(summary).toEqual({
          ok: true,
          accounts: 1,
          balances: 1,
          positions: 2,
          activities: 1,
          activitiesInserted: 1,
          activitiesSkipped: 0,
          transactions: 0,
          transactionsInserted: 0,
          transactionsSkipped: 0,
          accountsLinked: 0,
          historyPoints: 3,
          returnRates: 2,
          warnings: [],
        });

        // Only the read-only GET endpoints are ever touched, in sync order, and nothing
        // resembling a trading / money-movement path appears.
        expect(fake.requests.map((request) => request.path)).toEqual([
          "/accounts",
          "/accounts/acc-1/balances",
          "/accounts/acc-1/balanceHistory",
          "/accounts/acc-1/returnRates",
          "/accounts/acc-1/positions/all",
          "/accounts/acc-1/activities",
        ]);
        expect(fake.requests.every((request) => request.method === "GET")).toBe(
          true,
        );
        for (const request of fake.requests) {
          expect(request.path).not.toMatch(
            /trade|order|transfer|rebalance|withdraw|deposit/i,
          );
          // GET requests carry no body and sign a null content, matching the server side.
          expect(request.body).toBeUndefined();
          const url = new URL(request.url);
          const rawQuery = request.url.slice(request.url.indexOf("?") + 1);
          const query = new URLSearchParams(rawQuery);
          expect(query.get("clientId")).toBe(CLIENT_ID);
          expect(query.get("timestamp")).toMatch(/^\d+$/);
          const wire =
            `${request.url}${JSON.stringify(request.headers)}`.toLowerCase();
          expect(wire).not.toContain("userid");
          expect(wire).not.toContain("usersecret");
          expect(wire).not.toContain(CONSUMER_KEY.toLowerCase());
          expect(request.headers.signature).toBe(
            snapTradeSignature({
              content: null,
              path: url.pathname,
              query: rawQuery,
              consumerKey: CONSUMER_KEY,
            }),
          );
        }
      } finally {
        fake.restore();
      }

      const dashboard = getFinanceDashboard() as Dashboard;

      expect(dashboard.accounts).toHaveLength(1);
      const account = dashboard.accounts[0];
      expect(account).toMatchObject({
        source: "snaptrade",
        sourceId: "acc-1",
        sourceVariant: "questrade",
        name: "Brokerage RRSP",
        type: "investment",
        currency: "USD",
        balance: 15000.5,
        institution: "Questrade",
        mask: "5678",
        status: "active",
      });

      expect(dashboard.balances).toHaveLength(1);
      expect(dashboard.balances[0]).toMatchObject({
        accountId: account.id,
        currency: "USD",
        cash: 2500.25,
        buyingPower: 5000,
        source: "snaptrade",
      });

      expect(dashboard.positions).toHaveLength(2);
      const aapl = dashboard.positions.find(
        (position) => position.symbol === "AAPL",
      );
      const shop = dashboard.positions.find(
        (position) => position.symbol === "SHOP",
      );
      // marketValue is derived from units * price; averageCost is the per-share cost_basis.
      expect(aapl).toMatchObject({
        source: "snaptrade",
        currency: "USD",
        quantity: 10,
        marketValue: 1905,
        averageCost: 150.25,
        name: "Apple Inc.",
      });
      expect(shop).toMatchObject({
        source: "snaptrade",
        currency: "CAD",
        quantity: 5,
        marketValue: 500,
        averageCost: 80,
      });

      expect(dashboard.activities).toHaveLength(1);
      expect(dashboard.activities[0]).toMatchObject({
        source: "snaptrade",
        type: "buy",
        currency: "USD",
        symbol: "AAPL",
        amount: -1905,
        quantity: 10,
        price: 190.5,
      });
      expect(dashboard.transactions).toEqual([]);

      const today = new Date().toISOString().slice(0, 10);
      expect(dashboard.history).toEqual([
        {
          accountId: account.id,
          date: "2026-05-31",
          equity: 14000.25,
          cash: null,
          currency: "USD",
          source: "snaptrade",
        },
        {
          accountId: account.id,
          date: "2026-06-30",
          equity: 14800.75,
          cash: null,
          currency: "USD",
          source: "snaptrade",
        },
        {
          accountId: account.id,
          date: today,
          equity: 15000.5,
          cash: 2500.25,
          currency: "USD",
          source: "snaptrade",
        },
      ]);
      expect(
        dashboard.returnRates.map(
          ({
            accountId,
            source,
            sourceVariant,
            timeframe,
            returnPercent,
            asOf,
          }) => ({
            accountId,
            source,
            sourceVariant,
            timeframe,
            returnPercent,
            asOf,
          }),
        ),
      ).toEqual([
        {
          accountId: account.id,
          source: "snaptrade",
          sourceVariant: "questrade",
          timeframe: "1M",
          returnPercent: -2.5,
          asOf: "2026-06-30",
        },
        {
          accountId: account.id,
          source: "snaptrade",
          sourceVariant: "questrade",
          timeframe: "YTD",
          returnPercent: 7.25,
          asOf: "2026-06-30",
        },
      ]);

      // Currencies are never merged: the USD account holding a CAD-listed position yields two
      // separate currency groups, each containing only its own rows.
      expect(dashboard.byCurrency.map((group) => group.currency)).toEqual([
        "CAD",
        "USD",
      ]);
      const cad = dashboard.byCurrency.find(
        (group) => group.currency === "CAD",
      );
      const usd = dashboard.byCurrency.find(
        (group) => group.currency === "USD",
      );
      expect(cad?.accounts).toEqual([]);
      expect(cad?.positions.map((position) => position.symbol)).toEqual([
        "SHOP",
      ]);
      expect(usd?.accounts.map((entry) => entry.id)).toEqual([account.id]);
      expect(usd?.positions.map((position) => position.symbol)).toEqual([
        "AAPL",
      ]);
    });
  });

  test("classifies absent-category Wealthsimple MSB accounts as checking and promotes a positive card spend to one negative canonical transaction", async () => {
    await withIsolatedGateway(async (app) => {
      await saveCredentials(app);
      const fake = withFakeSnapTradeFetch(({ path }) => {
        if (path === "/accounts")
          return {
            payload: [SNAPTRADE_ACCOUNT, SNAPTRADE_WEALTHSIMPLE_MSB_ACCOUNT],
          };
        if (path === "/accounts/acc-1/balances") return { payload: [] };
        if (path === "/accounts/acc-1/balanceHistory")
          return { payload: { currency: "USD", history: [] } };
        if (path === "/accounts/acc-1/returnRates")
          return { payload: { data: [] } };
        if (path === "/accounts/acc-1/positions/all")
          return { payload: { results: [] } };
        if (path === "/accounts/acc-1/activities")
          return { payload: { data: [], pagination: { total: 0 } } };
        if (path === "/accounts/acc-wealthsimple-msb/balances")
          return { payload: SNAPTRADE_WEALTHSIMPLE_BALANCES };
        if (path === "/accounts/acc-wealthsimple-msb/balanceHistory")
          return { payload: { currency: "CAD", history: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/returnRates")
          return { payload: { data: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/positions/all")
          return { payload: { results: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/activities")
          return { payload: SNAPTRADE_WEALTHSIMPLE_SPEND_ACTIVITIES };
        throw new Error(`unexpected SnapTrade path: ${path}`);
      });
      try {
        const response = await app.request("/v1/integrations/snaptrade/sync", {
          method: "POST",
        });
        expect(response.status).toBe(200);
        expect((await response.json()) as SyncSummary).toMatchObject({
          ok: true,
          accounts: 2,
          balances: 1,
          positions: 0,
          activities: 0,
          activitiesInserted: 0,
          activitiesSkipped: 0,
          transactions: 1,
          transactionsInserted: 1,
          transactionsSkipped: 0,
          accountsLinked: 0,
          historyPoints: 2,
          returnRates: 0,
          warnings: [],
        });
      } finally {
        fake.restore();
      }

      const dashboard = getFinanceDashboard() as Dashboard;
      const investmentAccount = dashboard.accounts.find(
        (account) => account.sourceId === "acc-1",
      );
      const wealthsimpleAccount = dashboard.accounts.find(
        (account) => account.sourceId === "acc-wealthsimple-msb",
      );

      expect(investmentAccount).toMatchObject({
        source: "snaptrade",
        sourceId: "acc-1",
        sourceVariant: "questrade",
        name: "Brokerage RRSP",
        type: "investment",
        currency: "USD",
        balance: 15000.5,
        institution: "Questrade",
        mask: "5678",
        status: "active",
      });
      expect(wealthsimpleAccount).toMatchObject({
        source: "snaptrade",
        sourceId: "acc-wealthsimple-msb",
        sourceVariant: "wealthsimple",
        name: "Wealthsimple Trade MSB",
        type: "checking",
        currency: "CAD",
        balance: 742.13,
        institution: "Wealthsimple",
        mask: "4321",
        status: "active",
      });
      expect(
        dashboard.positions.filter(
          (position) => position.accountId === wealthsimpleAccount?.id,
        ),
      ).toEqual([]);
      expect(dashboard.transactions).toHaveLength(1);
      expect(dashboard.transactions[0]).toMatchObject({
        accountId: wealthsimpleAccount?.id,
        source: "snaptrade",
        sourceVariant: "wealthsimple",
        description: "Wealthsimple card purchase",
        amount: -42.5,
        currency: "CAD",
        categoryName: "card spend",
        categoryGroup: "spending",
        status: "posted",
      });
      expect(dashboard.activities).toEqual([]);
    });
  });

  test("promotes a negative Wealthsimple spend reversal to a positive canonical spending inflow", async () => {
    await withIsolatedGateway(async (app) => {
      await saveCredentials(app);
      const fake = withFakeSnapTradeFetch(({ path }) => {
        if (path === "/accounts")
          return { payload: [SNAPTRADE_WEALTHSIMPLE_MSB_ACCOUNT] };
        if (path === "/accounts/acc-wealthsimple-msb/balances")
          return { payload: SNAPTRADE_WEALTHSIMPLE_BALANCES };
        if (path === "/accounts/acc-wealthsimple-msb/balanceHistory")
          return { payload: { currency: "CAD", history: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/returnRates")
          return { payload: { data: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/positions/all")
          return { payload: { results: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/activities")
          return { payload: SNAPTRADE_WEALTHSIMPLE_SPEND_REVERSAL_ACTIVITIES };
        throw new Error(`unexpected SnapTrade path: ${path}`);
      });
      try {
        const response = await app.request("/v1/integrations/snaptrade/sync", {
          method: "POST",
        });
        expect(response.status).toBe(200);
        expect((await response.json()) as SyncSummary).toMatchObject({
          activities: 0,
          activitiesInserted: 0,
          activitiesSkipped: 0,
          transactions: 1,
          transactionsInserted: 1,
          transactionsSkipped: 0,
          accountsLinked: 0,
        });
      } finally {
        fake.restore();
      }

      const dashboard = getFinanceDashboard() as Dashboard;
      expect(dashboard.transactions).toHaveLength(1);
      expect(dashboard.transactions[0]).toMatchObject({
        source: "snaptrade",
        sourceVariant: "wealthsimple",
        description: "Wealthsimple card refund",
        amount: 12.34,
        currency: "CAD",
        categoryName: "card spend",
        categoryGroup: "spending",
        status: "posted",
      });
      expect(dashboard.activities).toEqual([]);
    });
  });

  test("preserves brokerage buy and sell activities and zero-valued security-shaped spends as activities instead of canonical transactions", async () => {
    await withIsolatedGateway(async (app) => {
      await saveCredentials(app);
      const fake = withFakeSnapTradeFetch(({ path }) => {
        if (path === "/accounts")
          return {
            payload: [SNAPTRADE_ACCOUNT, SNAPTRADE_WEALTHSIMPLE_MSB_ACCOUNT],
          };
        if (path === "/accounts/acc-1/balances") return { payload: [] };
        if (path === "/accounts/acc-1/balanceHistory")
          return { payload: { currency: "USD", history: [] } };
        if (path === "/accounts/acc-1/returnRates")
          return { payload: { data: [] } };
        if (path === "/accounts/acc-1/positions/all")
          return { payload: { results: [] } };
        if (path === "/accounts/acc-1/activities")
          return { payload: SNAPTRADE_BROKERAGE_BUY_SELL_ACTIVITIES };
        if (path === "/accounts/acc-wealthsimple-msb/balances")
          return { payload: [] };
        if (path === "/accounts/acc-wealthsimple-msb/balanceHistory")
          return { payload: { currency: "CAD", history: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/returnRates")
          return { payload: { data: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/positions/all")
          return { payload: { results: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/activities")
          return {
            payload: SNAPTRADE_WEALTHSIMPLE_SECURITY_SHAPED_SPEND_ACTIVITIES,
          };
        throw new Error(`unexpected SnapTrade path: ${path}`);
      });
      try {
        const response = await app.request("/v1/integrations/snaptrade/sync", {
          method: "POST",
        });
        expect(response.status).toBe(200);
        expect((await response.json()) as SyncSummary).toMatchObject({
          activities: 3,
          activitiesInserted: 3,
          activitiesSkipped: 0,
          transactions: 0,
          transactionsInserted: 0,
          transactionsSkipped: 0,
          accountsLinked: 0,
        });
      } finally {
        fake.restore();
      }

      const dashboard = getFinanceDashboard() as Dashboard;
      expect(dashboard.transactions).toEqual([]);
      expect(dashboard.activities).toHaveLength(3);
      expect(
        dashboard.activities.find(
          (activity) => activity.type === "buy" && activity.symbol === "AAPL",
        ),
      ).toMatchObject({
        source: "snaptrade",
        currency: "USD",
        amount: -1905,
        quantity: 10,
        price: 190.5,
      });
      expect(
        dashboard.activities.find(
          (activity) => activity.type === "sell" && activity.symbol === "MSFT",
        ),
      ).toMatchObject({
        source: "snaptrade",
        currency: "USD",
        amount: 1010,
        quantity: 5,
        price: 202,
      });
      expect(
        dashboard.activities.find(
          (activity) => activity.type === "spend" && activity.symbol === "CASH",
        ),
      ).toMatchObject({
        source: "snaptrade",
        currency: "CAD",
        amount: 27.75,
        quantity: 0,
        price: 0,
      });
    });
  });

  test("continues syncing the current account snapshot and warning summary when optional history and return-rate endpoints are forbidden", async () => {
    await withIsolatedGateway(async (app) => {
      await saveCredentials(app);
      const fake = withFakeSnapTradeFetch(({ path }) => {
        if (path === "/accounts") return { payload: [SNAPTRADE_ACCOUNT] };
        if (path === "/accounts/acc-1/balances")
          return { payload: SNAPTRADE_BALANCES };
        if (path === "/accounts/acc-1/balanceHistory")
          return { status: 403, payload: { error: "forbidden" } };
        if (path === "/accounts/acc-1/returnRates")
          return { status: 403, payload: { error: "forbidden" } };
        if (path === "/accounts/acc-1/positions/all")
          return { payload: { results: [] } };
        if (path === "/accounts/acc-1/activities")
          return { payload: { data: [], pagination: { total: 0 } } };
        throw new Error(`unexpected SnapTrade path: ${path}`);
      });
      try {
        const response = await app.request("/v1/integrations/snaptrade/sync", {
          method: "POST",
        });
        expect(response.status).toBe(200);
        expect((await response.json()) as SyncSummary).toMatchObject({
          ok: true,
          accounts: 1,
          balances: 1,
          positions: 0,
          activities: 0,
          activitiesInserted: 0,
          activitiesSkipped: 0,
          transactions: 0,
          transactionsInserted: 0,
          transactionsSkipped: 0,
          accountsLinked: 0,
          historyPoints: 1,
          returnRates: 0,
          warnings: [
            "Brokerage RRSP: balance history is unavailable",
            "Brokerage RRSP: return rates are unavailable",
          ],
        });
      } finally {
        fake.restore();
      }

      const dashboard = getFinanceDashboard() as Dashboard;
      const account = dashboard.accounts[0];
      const today = new Date().toISOString().slice(0, 10);
      expect(dashboard.history).toEqual([
        {
          accountId: account.id,
          date: today,
          equity: 15000.5,
          cash: 2500.25,
          currency: "USD",
          source: "snaptrade",
        },
      ]);
      expect(dashboard.returnRates).toEqual([]);
      expect(fake.requests.map((request) => request.path)).toEqual([
        "/accounts",
        "/accounts/acc-1/balances",
        "/accounts/acc-1/balanceHistory",
        "/accounts/acc-1/returnRates",
        "/accounts/acc-1/positions/all",
        "/accounts/acc-1/activities",
      ]);
    });
  });

  test("re-syncing reports the same activity as a skipped duplicate and does not create a second activity row", async () => {
    await withIsolatedGateway(async (app) => {
      await saveCredentials(app);
      const fake = withFakeSnapTradeFetch(({ path }) => {
        if (path === "/accounts") return { payload: [SNAPTRADE_ACCOUNT] };
        if (path === "/accounts/acc-1/balances") return { payload: [] };
        if (path === "/accounts/acc-1/balanceHistory")
          return { payload: { currency: "USD", history: [] } };
        if (path === "/accounts/acc-1/returnRates")
          return { payload: { data: [] } };
        if (path === "/accounts/acc-1/positions/all")
          return { payload: { results: [] } };
        if (path === "/accounts/acc-1/activities")
          return { payload: SNAPTRADE_ACTIVITIES };
        throw new Error(`unexpected SnapTrade path: ${path}`);
      });
      try {
        const first = await app.request("/v1/integrations/snaptrade/sync", {
          method: "POST",
        });
        expect(first.status).toBe(200);
        expect((await first.json()) as SyncSummary).toMatchObject({
          activities: 1,
          activitiesInserted: 1,
          activitiesSkipped: 0,
          transactions: 0,
          transactionsInserted: 0,
          transactionsSkipped: 0,
          accountsLinked: 0,
        });

        const second = await app.request("/v1/integrations/snaptrade/sync", {
          method: "POST",
        });
        expect(second.status).toBe(200);
        expect((await second.json()) as SyncSummary).toMatchObject({
          activities: 1,
          activitiesInserted: 0,
          activitiesSkipped: 1,
          transactions: 0,
          transactionsInserted: 0,
          transactionsSkipped: 0,
          accountsLinked: 0,
        });
      } finally {
        fake.restore();
      }

      const dashboard = getFinanceDashboard() as Dashboard;
      expect(dashboard.activities).toHaveLength(1);
      expect(dashboard.transactions).toEqual([]);
    });
  });

  test("re-syncing a promoted Wealthsimple spend reports a skipped canonical transaction and keeps one transaction row", async () => {
    await withIsolatedGateway(async (app) => {
      await saveCredentials(app);
      const fake = withFakeSnapTradeFetch(({ path }) => {
        if (path === "/accounts")
          return { payload: [SNAPTRADE_WEALTHSIMPLE_MSB_ACCOUNT] };
        if (path === "/accounts/acc-wealthsimple-msb/balances")
          return { payload: SNAPTRADE_WEALTHSIMPLE_BALANCES };
        if (path === "/accounts/acc-wealthsimple-msb/balanceHistory")
          return { payload: { currency: "CAD", history: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/returnRates")
          return { payload: { data: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/positions/all")
          return { payload: { results: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/activities")
          return { payload: SNAPTRADE_WEALTHSIMPLE_SPEND_ACTIVITIES };
        throw new Error(`unexpected SnapTrade path: ${path}`);
      });
      try {
        const first = await app.request("/v1/integrations/snaptrade/sync", {
          method: "POST",
        });
        expect(first.status).toBe(200);
        expect((await first.json()) as SyncSummary).toMatchObject({
          activities: 0,
          activitiesInserted: 0,
          activitiesSkipped: 0,
          transactions: 1,
          transactionsInserted: 1,
          transactionsSkipped: 0,
          accountsLinked: 0,
        });

        const second = await app.request("/v1/integrations/snaptrade/sync", {
          method: "POST",
        });
        expect(second.status).toBe(200);
        expect((await second.json()) as SyncSummary).toMatchObject({
          activities: 0,
          activitiesInserted: 0,
          activitiesSkipped: 0,
          transactions: 1,
          transactionsInserted: 0,
          transactionsSkipped: 1,
          accountsLinked: 0,
        });
      } finally {
        fake.restore();
      }

      const dashboard = getFinanceDashboard() as Dashboard;
      expect(dashboard.transactions).toHaveLength(1);
      expect(dashboard.transactions[0]).toMatchObject({
        source: "snaptrade",
        sourceVariant: "wealthsimple",
        description: "Wealthsimple card purchase",
        amount: -42.5,
        currency: "CAD",
        categoryGroup: "spending",
      });
      expect(dashboard.activities).toEqual([]);
    });
  });

  test("lazily removes a pre-cutover Wealthsimple spend activity when the same spend is promoted", async () => {
    await withIsolatedGateway(async (app) => {
      await saveCredentials(app);
      const seeded = upsertFinanceActivity({
        accountId: null,
        source: "snaptrade",
        sourceId: "act-wealthsimple-spend-1",
        sourceVariant: "wealthsimple",
        type: "spend",
        description: "Wealthsimple card purchase",
        amount: 42.5,
        currency: "CAD",
        symbol: null,
        quantity: null,
        price: null,
        fingerprint: "act-wealthsimple-spend-1",
        status: "posted",
        occurredAt: "2026-06-12",
        settledAt: "2026-06-12",
        importId: null,
      });
      expect(seeded.inserted).toBe(true);

      const fake = withFakeSnapTradeFetch(({ path }) => {
        if (path === "/accounts")
          return { payload: [SNAPTRADE_WEALTHSIMPLE_MSB_ACCOUNT] };
        if (path === "/accounts/acc-wealthsimple-msb/balances")
          return { payload: SNAPTRADE_WEALTHSIMPLE_BALANCES };
        if (path === "/accounts/acc-wealthsimple-msb/balanceHistory")
          return { payload: { currency: "CAD", history: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/returnRates")
          return { payload: { data: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/positions/all")
          return { payload: { results: [] } };
        if (path === "/accounts/acc-wealthsimple-msb/activities")
          return { payload: SNAPTRADE_WEALTHSIMPLE_SPEND_ACTIVITIES };
        throw new Error(`unexpected SnapTrade path: ${path}`);
      });
      try {
        const response = await app.request("/v1/integrations/snaptrade/sync", {
          method: "POST",
        });
        expect(response.status).toBe(200);
        expect((await response.json()) as SyncSummary).toMatchObject({
          activities: 0,
          activitiesInserted: 0,
          activitiesSkipped: 0,
          transactions: 1,
          transactionsInserted: 1,
          transactionsSkipped: 0,
          accountsLinked: 0,
        });
      } finally {
        fake.restore();
      }

      const dashboard = getFinanceDashboard() as Dashboard;
      expect(dashboard.transactions).toHaveLength(1);
      expect(dashboard.transactions[0]).toMatchObject({
        source: "snaptrade",
        sourceVariant: "wealthsimple",
        description: "Wealthsimple card purchase",
        amount: -42.5,
        categoryGroup: "spending",
      });
      expect(dashboard.activities).toEqual([]);
    });
  });
});
