import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getFinanceDashboard,
  type FinanceDashboard,
} from "../src/capability/finance/data";
import { setSnapTradeFetch } from "../src/capability/finance/snaptrade";
import { getDatabase, resetDatabaseForTests } from "../src/core/db/database";
import { createApp } from "../src/platform/gateway/app";

type GatewayApp = {
  request(input: string | Request, init?: RequestInit): Promise<Response>;
};

type CapturedRequest = {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

type SnapTradeResponse = { status?: number; payload: unknown };

type CsvImportResult = {
  imported: number;
  skippedDuplicates: number;
  skippedCrossSource: number;
  accountId: string;
  importId: string;
  status: string;
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

type LinkResult = {
  linked: true;
  canonicalAccountId: string;
  duplicateAccountId: string;
  transactionsMerged: number;
  transactionsRekeyed: number;
};

const CLIENT_ID = "snaptrade-client-1234";
const CONSUMER_KEY = "consumer-hmac-key-ABCDEF";

const WEALTHSIMPLE_MSB_ACCOUNT = {
  id: "acc-wealthsimple-msb",
  name: "Wealthsimple Trade MSB",
  institution_name: "Wealthsimple",
  number: "987654321",
  raw_type: "MSB",
  status: "ACTIVE",
  balance: { total: { currency: "CAD", amount: 742.13 } },
};

const WEALTHSIMPLE_BALANCES = [
  { currency: { code: "CAD" }, cash: 742.13, buying_power: null },
];

async function withIsolatedGateway(
  run: (app: GatewayApp) => Promise<void>,
): Promise<void> {
  const oldHome = process.env.HOME;
  const oldToken = process.env.ANORVIS_OS_API_TOKEN;
  const oldDbPath = process.env.ANORVIS_DB_PATH;
  const oldSecretProvider = process.env.ANORVIS_SECRET_PROVIDER;
  const oldSecretKeyPath = process.env.ANORVIS_SECRET_KEY_PATH;
  process.env.HOME = mkdtempSync(join(tmpdir(), "anorvis-finance-links-"));
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

function snapTradeHandler(options: {
  accounts?: Array<typeof WEALTHSIMPLE_MSB_ACCOUNT>;
  activitiesByAccount?: Record<string, unknown[]>;
  balancesByAccount?: Record<string, unknown[]>;
}): (request: { path: string; method: string }) => SnapTradeResponse {
  const accounts = options.accounts ?? [WEALTHSIMPLE_MSB_ACCOUNT];
  const activitiesByAccount = options.activitiesByAccount ?? {};
  const balancesByAccount = options.balancesByAccount ?? {
    [WEALTHSIMPLE_MSB_ACCOUNT.id]: WEALTHSIMPLE_BALANCES,
  };
  return ({ path }) => {
    if (path === "/accounts") return { payload: accounts };
    for (const account of accounts) {
      const accountId = account.id;
      const currency = account.balance.total.currency;
      if (path === `/accounts/${accountId}/balances`) {
        return { payload: balancesByAccount[accountId] ?? [] };
      }
      if (path === `/accounts/${accountId}/balanceHistory`) {
        return { payload: { currency, history: [] } };
      }
      if (path === `/accounts/${accountId}/returnRates`) {
        return { payload: { data: [] } };
      }
      if (path === `/accounts/${accountId}/positions/all`) {
        return { payload: { results: [] } };
      }
      if (path === `/accounts/${accountId}/activities`) {
        const data = activitiesByAccount[accountId] ?? [];
        return { payload: { data, pagination: { total: data.length } } };
      }
    }
    throw new Error(`unexpected SnapTrade path: ${path}`);
  };
}

function spendActivity(
  id: string,
  overrides: Partial<{
    description: string;
    amount: number;
    trade_date: string;
    settlement_date: string;
  }> = {},
): unknown {
  return {
    id,
    type: "SPEND",
    trade_date: overrides.trade_date ?? "2026-06-12",
    settlement_date:
      overrides.settlement_date ?? overrides.trade_date ?? "2026-06-12",
    currency: { code: "CAD" },
    amount: overrides.amount ?? 42.5,
    description: overrides.description ?? "Wealthsimple card purchase",
  };
}

function csvTransaction(
  fingerprint: string,
  overrides: Partial<{
    externalId: string | null;
    date: string;
    description: string;
    amount: number;
    category: string;
    currency: string;
  }> = {},
): Record<string, unknown> {
  return {
    fingerprint,
    externalId: overrides.externalId ?? null,
    date: overrides.date ?? "2026-06-12",
    description: overrides.description ?? "Wealthsimple card purchase",
    amount: overrides.amount ?? -42.5,
    category: overrides.category ?? "card spend",
    currency: overrides.currency ?? "CAD",
  };
}

type ManualAccountType =
  "checking" | "savings" | "credit" | "investment" | "crypto" | "loan";

type ManualAccount = {
  id: string;
  source: string;
  name: string;
  type: string;
  currency: string;
  balance: number | null;
};

async function createManualAccount(
  app: GatewayApp,
  options: {
    name: string;
    type?: ManualAccountType;
    currency?: string;
    balance?: number | null;
  },
): Promise<ManualAccount> {
  const response = await app.request("/v1/finance/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: options.name,
      type: options.type ?? "checking",
      currency: options.currency ?? "CAD",
      ...(options.balance !== undefined ? { balance: options.balance } : {}),
    }),
  });
  expect(response.status).toBe(201);
  const payload = (await response.json()) as {
    ok: true;
    account: ManualAccount;
  };
  expect(payload.ok).toBe(true);
  expect(payload.account.source).toBe("manual");
  expect(payload.account.name).toBe(options.name);
  expect(payload.account.type).toBe(options.type ?? "checking");
  expect(payload.account.currency).toBe(options.currency ?? "CAD");
  return payload.account;
}

function setManualAccountIdentity(
  accountId: string,
  identity: { institution: string; mask: string },
): void {
  const result = getDatabase()
    .query(
      "UPDATE finance_accounts SET institution = ?2, mask = ?3 WHERE id = ?1 AND source = 'manual'",
    )
    .run(accountId, identity.institution, identity.mask);
  expect(result.changes).toBe(1);
}

function csvImportBody(options: {
  accountId: string;
  source?: "wealthsimple" | "manual";
  balance?: number | null;
  transactions?: Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    source: options.source ?? "wealthsimple",
    accountId: options.accountId,
    ...(options.balance !== undefined ? { balance: options.balance } : {}),
    transactions: options.transactions ?? [],
  };
}

async function importCsvIntoNewAccount(
  app: GatewayApp,
  options: {
    accountName: string;
    source?: "wealthsimple" | "manual";
    accountType?: ManualAccountType;
    accountCurrency?: string;
    balance?: number | null;
    transactions?: Record<string, unknown>[];
  },
): Promise<CsvImportResult> {
  const account = await createManualAccount(app, {
    name: options.accountName,
    type: options.accountType ?? "checking",
    currency: options.accountCurrency ?? "CAD",
  });
  return importCsv(
    app,
    csvImportBody({
      accountId: account.id,
      source: options.source,
      balance: options.balance,
      transactions: options.transactions,
    }),
  );
}

async function importCsv(
  app: GatewayApp,
  body: Record<string, unknown>,
): Promise<CsvImportResult> {
  const response = await app.request("/v1/finance/imports/csv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as CsvImportResult;
}

async function saveCredentials(app: GatewayApp): Promise<void> {
  const response = await app.request("/v1/integrations/snaptrade/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT_ID, consumerKey: CONSUMER_KEY }),
  });
  expect(response.status).toBe(200);
}

async function syncSnapTrade(
  app: GatewayApp,
  activities: unknown[],
  accounts: Array<typeof WEALTHSIMPLE_MSB_ACCOUNT> = [WEALTHSIMPLE_MSB_ACCOUNT],
): Promise<SyncSummary> {
  await saveCredentials(app);
  const fake = withFakeSnapTradeFetch(
    snapTradeHandler({
      accounts,
      activitiesByAccount: { [WEALTHSIMPLE_MSB_ACCOUNT.id]: activities },
    }),
  );
  try {
    const response = await app.request("/v1/integrations/snaptrade/sync", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    return (await response.json()) as SyncSummary;
  } finally {
    fake.restore();
  }
}

async function linkAccounts(
  app: GatewayApp,
  canonicalAccountId: string,
  duplicateAccountId: string,
): Promise<Response> {
  return app.request("/v1/finance/accounts/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canonicalAccountId, duplicateAccountId }),
  });
}

function linkRow(
  accountId: string,
): { canonical_account_id: string; method: string } | null {
  return (
    getDatabase()
      .query<{ canonical_account_id: string; method: string }, [string]>(
        "SELECT canonical_account_id, method FROM finance_account_links WHERE account_id = ?1",
      )
      .get(accountId) ?? null
  );
}

function transactionRows(): Array<{
  account_id: string | null;
  source: string;
  importId: string | null;
  fingerprint: string;
  dedupe_key: string | null;
}> {
  return getDatabase()
    .query<
      {
        account_id: string | null;
        source: string;
        importId: string | null;
        fingerprint: string;
        dedupe_key: string | null;
      },
      []
    >(
      `
      SELECT
        account_id,
        source,
        import_id AS importId,
        fingerprint,
        dedupe_key
      FROM finance_transactions
      ORDER BY source, fingerprint
    `,
    )
    .all();
}

function importReceipt(importId: string): {
  id: string;
  source: string;
  accountId: string | null;
  status: string;
  importedCount: number;
} | null {
  return (
    getDatabase()
      .query<
        {
          id: string;
          source: string;
          accountId: string | null;
          status: string;
          importedCount: number;
        },
        [string]
      >(
        `
        SELECT
          id,
          source,
          account_id AS accountId,
          status,
          imported_count AS importedCount
        FROM finance_imports
        WHERE id = ?1
      `,
      )
      .get(importId) ?? null
  );
}

function accountRows(): Array<{
  id: string;
  source: string;
  importId: string | null;
  name: string;
}> {
  return getDatabase()
    .query<
      {
        id: string;
        source: string;
        importId: string | null;
        name: string;
      },
      []
    >(
      `
      SELECT id, source, import_id AS importId, name
      FROM finance_accounts
      ORDER BY source, name
    `,
    )
    .all();
}

function financeImportCount(): number {
  return (
    getDatabase()
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM finance_imports",
      )
      .get()?.count ?? 0
  );
}

function dependentAccountRows(accountId: string): {
  balances: number;
  history: number;
} {
  const balances =
    getDatabase()
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM finance_balances WHERE account_id = ?1",
      )
      .get(accountId)?.count ?? 0;
  const history =
    getDatabase()
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM finance_account_value_history WHERE account_id = ?1",
      )
      .get(accountId)?.count ?? 0;
  return { balances, history };
}

function accountHistoryRows(accountId: string): Array<{
  account_id: string;
  source: string;
  date: string;
  equity: number;
  cash: number | null;
  currency: string;
}> {
  return getDatabase()
    .query<
      {
        account_id: string;
        source: string;
        date: string;
        equity: number;
        cash: number | null;
        currency: string;
      },
      [string]
    >(
      `
      SELECT account_id, source, date, equity, cash, currency
      FROM finance_account_value_history
      WHERE account_id = ?1
      ORDER BY date
    `,
    )
    .all(accountId);
}

function seedLegacyCsvOrphan(): { accountId: string; importId: string } {
  const accountId = "legacy-csv-orphan-account";
  const importId = "legacy-csv-orphan-import";
  const timestamp = "2026-06-30T12:00:00.000Z";
  getDatabase().transaction(() => {
    getDatabase()
      .query(
        `
        INSERT INTO finance_accounts (
          id, source, source_id, source_variant, name, type, currency, balance,
          institution, mask, status, import_id, observed_at, created_at, updated_at
        ) VALUES (
          ?1, 'csv', NULL, 'manual', 'Legacy CSV Orphan', 'checking', 'USD', 123,
          NULL, NULL, 'active', ?2, ?3, ?3, ?3
        )
      `,
      )
      .run(accountId, importId, timestamp);
    getDatabase()
      .query(
        `
        INSERT INTO finance_imports (
          id, source, source_variant, account_id, status, imported_count,
          skipped_count, error, started_at, finished_at, created_at, updated_at
        ) VALUES (
          ?1, 'csv', 'manual', ?2, 'completed', 1,
          0, NULL, ?3, ?3, ?3, ?3
        )
      `,
      )
      .run(importId, accountId, timestamp);
    getDatabase()
      .query(
        `
        INSERT INTO finance_transactions (
          id, account_id, source, source_id, source_variant, import_id,
          fingerprint, description, amount, currency, posted_at, category_id,
          status, notes, dedupe_key, created_at, updated_at
        ) VALUES (
          'legacy-csv-orphan-transaction', ?1, 'csv', NULL, 'manual', ?2,
          'legacy-csv-orphan-fingerprint', 'Legacy CSV transaction', -12.34,
          'USD', '2026-06-30', NULL, 'posted', NULL,
          'legacy-csv-orphan-dedupe', ?3, ?3
        )
      `,
      )
      .run(accountId, importId, timestamp);
    getDatabase()
      .query(
        `
        INSERT INTO finance_balances (
          id, account_id, currency, cash, buying_power, observed_at, source,
          source_variant, import_id, created_at, updated_at
        ) VALUES (
          'legacy-csv-orphan-balance', ?1, 'USD', 123, NULL, ?3, 'csv',
          'manual', ?2, ?3, ?3
        )
      `,
      )
      .run(accountId, importId, timestamp);
    getDatabase()
      .query(
        `
        INSERT INTO finance_account_value_history (
          id, account_id, source, source_variant, date, equity, cash, currency,
          import_id, observed_at, created_at, updated_at
        ) VALUES (
          'legacy-csv-orphan-history', ?1, 'csv', 'manual', '2026-06-30',
          123, NULL, 'USD', ?2, ?3, ?3, ?3
        )
      `,
      )
      .run(accountId, importId, timestamp);
  })();
  return { accountId, importId };
}

describe("finance account links and canonical transaction dedupe", () => {
  test("manual link reconciles matching provider rows while hiding the shadow account balance and history", async () => {
    await withIsolatedGateway(async (app) => {
      const csv = await importCsvIntoNewAccount(app, {
        accountName: "Wealthsimple CSV cash",
        accountType: "checking",
        accountCurrency: "CAD",
        balance: 742.13,
        transactions: [csvTransaction("csv-wealthsimple-spend-1")],
      });

      const sync = await syncSnapTrade(app, [
        spendActivity("act-wealthsimple-spend-1"),
      ]);
      expect(sync).toMatchObject({
        accountsLinked: 0,
        transactions: 1,
        transactionsInserted: 1,
        transactionsSkipped: 0,
      });

      let dashboard = getFinanceDashboard();
      expect(dashboard.accounts).toHaveLength(2);
      expect(dashboard.transactions).toHaveLength(2);
      const canonical = dashboard.accounts.find(
        (account) => account.source === "snaptrade",
      );
      const duplicate = dashboard.accounts.find(
        (account) => account.id === csv.accountId,
      );
      expect(canonical).toMatchObject({
        source: "snaptrade",
        sourceId: "acc-wealthsimple-msb",
        type: "checking",
        currency: "CAD",
        mask: "4321",
      });
      expect(duplicate).toMatchObject({
        id: csv.accountId,
        source: "manual",
        sourceVariant: null,
        currency: "CAD",
      });

      const linkResponse = await linkAccounts(
        app,
        canonical!.id,
        duplicate!.id,
      );
      expect(linkResponse.status).toBe(201);
      const link = (await linkResponse.json()) as LinkResult;
      expect(link.linked).toBe(true);
      expect(link.canonicalAccountId).toBe(canonical!.id);
      expect(link.duplicateAccountId).toBe(duplicate!.id);
      expect(link.transactionsMerged).toBe(1);

      dashboard = getFinanceDashboard();
      expect(dashboard.accounts.map((account) => account.id)).toEqual([
        canonical!.id,
      ]);
      expect(dashboard.balances).toHaveLength(1);
      const balance = dashboard.balances[0];
      expect(balance.accountId).toBe(canonical!.id);
      expect(balance.source).toBe("snaptrade");
      expect(balance.currency).toBe("CAD");
      expect(balance.cash).toBe(742.13);
      expect(dashboard.transactions).toHaveLength(1);
      const transaction = dashboard.transactions[0];
      expect(transaction.accountId).toBe(canonical!.id);
      expect(transaction.amount).toBe(-42.5);
      expect(transaction.currency).toBe("CAD");
      expect(transaction.description).toBe("Wealthsimple card purchase");

      const reportingResponse = await app.request(
        "/v1/finance/dashboard?currency=CAD",
      );
      expect(reportingResponse.status).toBe(200);
      const reporting = (await reportingResponse.json()) as FinanceDashboard;
      expect(reporting.history.at(-1)).toMatchObject({
        accountId: null,
        equity: 742.13,
        cash: 742.13,
        currency: "CAD",
        source: "portfolio",
      });
    });
  });

  test("same-source identical transactions keep separate occurrence slots and re-import by fingerprint is skipped", async () => {
    await withIsolatedGateway(async (app) => {
      const account = await createManualAccount(app, {
        name: "Duplicate merchant cash",
        type: "checking",
        currency: "CAD",
      });
      const body = csvImportBody({
        accountId: account.id,
        transactions: [
          csvTransaction("csv-identical-1", {
            description: "Coffee Shop",
            amount: -5.55,
          }),
          csvTransaction("csv-identical-2", {
            description: "Coffee Shop",
            amount: -5.55,
          }),
        ],
      });

      const first = await importCsv(app, body);
      expect(first.imported).toBe(2);
      expect(first.skippedDuplicates).toBe(0);
      expect(first.skippedCrossSource).toBe(0);
      expect(getFinanceDashboard().transactions).toHaveLength(2);
      expect(new Set(transactionRows().map((row) => row.dedupe_key)).size).toBe(
        2,
      );

      const second = await importCsv(app, body);
      expect(second.imported).toBe(0);
      expect(second.skippedDuplicates).toBe(2);
      expect(second.skippedCrossSource).toBe(0);
      expect(second.accountId).toBe(first.accountId);
      expect(getFinanceDashboard().transactions).toHaveLength(2);
    });
  });

  test("CSV imports require a selected manual account, reject currency mismatches, and never create CSV account rows", async () => {
    await withIsolatedGateway(async (app) => {
      const missingAccount = await app.request("/v1/finance/imports/csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "manual",
          transactions: [],
        }),
      });
      expect(missingAccount.status).toBe(400);
      expect(await missingAccount.json()).toEqual({
        error: "invalid finance import",
      });
      expect(financeImportCount()).toBe(0);

      const account = await createManualAccount(app, {
        name: "Validated import cash",
        type: "checking",
        currency: "USD",
      });
      const mismatchedCurrency = await app.request("/v1/finance/imports/csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          csvImportBody({
            accountId: account.id,
            source: "manual",
            transactions: [
              csvTransaction("currency-mismatch-cad", {
                currency: "CAD",
              }),
            ],
          }),
        ),
      });
      expect(mismatchedCurrency.status).toBe(409);
      expect(await mismatchedCurrency.json()).toEqual({
        error: "transaction currency does not match account",
      });
      expect(financeImportCount()).toBe(0);

      const imported = await importCsv(
        app,
        csvImportBody({
          accountId: account.id,
          source: "manual",
          balance: 77,
          transactions: [
            csvTransaction("validated-usd-import", {
              amount: -3.21,
              currency: "USD",
            }),
          ],
        }),
      );
      expect(imported.accountId).toBe(account.id);
      expect(imported.imported).toBe(1);
      expect(importReceipt(imported.importId)).toEqual({
        id: imported.importId,
        source: "csv",
        accountId: account.id,
        status: "completed",
        importedCount: 1,
      });
      expect(accountRows()).toEqual([
        {
          id: account.id,
          source: "manual",
          importId: null,
          name: "Validated import cash",
        },
      ]);
      expect(transactionRows().map((row) => row.account_id)).toEqual([
        account.id,
      ]);
    });
  });

  test("CSV import undo deletes only the selected receipt's CSV transactions and refuses provider receipts", async () => {
    await withIsolatedGateway(async (app) => {
      const target = await importCsvIntoNewAccount(app, {
        source: "manual",
        accountName: "Undo target cash",
        accountType: "checking",
        accountCurrency: "USD",
        balance: 100,
        transactions: [
          csvTransaction("undo-target-csv-1", {
            description: "Target groceries",
            amount: -21.5,
            currency: "USD",
          }),
          csvTransaction("undo-target-csv-2", {
            description: "Target payroll",
            amount: 250,
            currency: "USD",
          }),
        ],
      });
      expect(target.imported).toBe(2);

      const keeper = await importCsvIntoNewAccount(app, {
        source: "manual",
        accountName: "Undo keeper cash",
        accountType: "checking",
        accountCurrency: "USD",
        balance: 200,
        transactions: [
          csvTransaction("undo-keep-csv-1", {
            description: "Kept transfer",
            amount: -7,
            currency: "USD",
          }),
        ],
      });
      expect(keeper.imported).toBe(1);

      const providerSync = await syncSnapTrade(app, [
        spendActivity("undo-keep-provider-spend", {
          description: "Provider card purchase",
          amount: 9.99,
        }),
      ]);
      expect(providerSync).toMatchObject({
        transactions: 1,
        transactionsInserted: 1,
        transactionsSkipped: 0,
      });
      const providerReceipt = getDatabase()
        .query<{ id: string }, []>(
          "SELECT id FROM finance_imports WHERE source = 'snaptrade'",
        )
        .get();
      expect(providerReceipt).toBeDefined();
      const providerImportId = providerReceipt!.id;

      expect(
        transactionRows().map((row) => ({
          source: row.source,
          importId: row.importId,
          fingerprint: row.fingerprint,
        })),
      ).toEqual([
        {
          source: "csv",
          importId: keeper.importId,
          fingerprint: "undo-keep-csv-1",
        },
        {
          source: "csv",
          importId: target.importId,
          fingerprint: "undo-target-csv-1",
        },
        {
          source: "csv",
          importId: target.importId,
          fingerprint: "undo-target-csv-2",
        },
        {
          source: "snaptrade",
          importId: providerImportId,
          fingerprint: "undo-keep-provider-spend",
        },
      ]);

      const undo = await app.request(
        `/v1/finance/imports/${encodeURIComponent(target.importId)}`,
        { method: "DELETE" },
      );
      expect(undo.status).toBe(200);
      expect(await undo.json()).toEqual({
        ok: true,
        importId: target.importId,
        deletedTransactions: 2,
        deletedAccountId: null,
      });

      expect(importReceipt(target.importId)).toEqual({
        id: target.importId,
        source: "csv",
        accountId: target.accountId,
        status: "undone",
        importedCount: 0,
      });
      expect(importReceipt(keeper.importId)).toEqual({
        id: keeper.importId,
        source: "csv",
        accountId: keeper.accountId,
        status: "completed",
        importedCount: 1,
      });
      const providerReceiptAfterUndo = importReceipt(providerImportId);
      expect(providerReceiptAfterUndo?.id).toBe(providerImportId);
      expect(providerReceiptAfterUndo?.source).toBe("snaptrade");
      expect(providerReceiptAfterUndo?.status).toBe("completed");

      const accountsAfterUndo = accountRows();
      expect(
        accountsAfterUndo.find((account) => account.id === target.accountId),
      ).toEqual({
        id: target.accountId,
        source: "manual",
        importId: null,
        name: "Undo target cash",
      });
      expect(
        accountsAfterUndo.find((account) => account.id === keeper.accountId),
      ).toEqual({
        id: keeper.accountId,
        source: "manual",
        importId: null,
        name: "Undo keeper cash",
      });
      expect(
        accountsAfterUndo.some((account) => account.source === "csv"),
      ).toBe(false);
      expect(dependentAccountRows(target.accountId)).toEqual({
        balances: 0,
        history: 0,
      });
      expect(dependentAccountRows(keeper.accountId)).toEqual({
        balances: 1,
        history: 1,
      });
      const providerAccountAfterUndo = accountsAfterUndo.find(
        (account) =>
          account.source === "snaptrade" &&
          account.importId === providerImportId,
      );
      expect(providerAccountAfterUndo?.source).toBe("snaptrade");
      expect(providerAccountAfterUndo?.importId).toBe(providerImportId);
      expect(providerAccountAfterUndo?.name).toBe("Wealthsimple Trade MSB");

      const remainingTransactions = transactionRows().map((row) => ({
        source: row.source,
        importId: row.importId,
        fingerprint: row.fingerprint,
      }));
      expect(remainingTransactions).toEqual([
        {
          source: "csv",
          importId: keeper.importId,
          fingerprint: "undo-keep-csv-1",
        },
        {
          source: "snaptrade",
          importId: providerImportId,
          fingerprint: "undo-keep-provider-spend",
        },
      ]);

      const repeatedUndo = await app.request(
        `/v1/finance/imports/${encodeURIComponent(target.importId)}`,
        { method: "DELETE" },
      );
      expect(repeatedUndo.status).toBe(200);
      expect(await repeatedUndo.json()).toEqual({
        ok: true,
        importId: target.importId,
        deletedTransactions: 0,
        deletedAccountId: null,
      });
      expect(transactionRows().map((row) => row.fingerprint)).toEqual([
        "undo-keep-csv-1",
        "undo-keep-provider-spend",
      ]);

      const providerBeforeReject = importReceipt(providerImportId);
      const rejectProviderUndo = await app.request(
        `/v1/finance/imports/${encodeURIComponent(providerImportId)}`,
        { method: "DELETE" },
      );
      expect(rejectProviderUndo.status).toBe(409);
      expect(await rejectProviderUndo.json()).toEqual({
        error: "import is not a csv import",
      });
      expect(importReceipt(providerImportId)).toEqual(providerBeforeReject);
      expect(
        transactionRows().map((row) => ({
          source: row.source,
          importId: row.importId,
          fingerprint: row.fingerprint,
        })),
      ).toEqual(remainingTransactions);
    });
  });

  test("CSV import undo deletes a proven legacy orphan CSV account and its import-scoped balance history", async () => {
    await withIsolatedGateway(async (app) => {
      const legacy = seedLegacyCsvOrphan();
      expect(accountRows()).toEqual([
        {
          id: legacy.accountId,
          source: "csv",
          importId: legacy.importId,
          name: "Legacy CSV Orphan",
        },
      ]);
      expect(dependentAccountRows(legacy.accountId)).toEqual({
        balances: 1,
        history: 1,
      });
      expect(transactionRows().map((row) => row.fingerprint)).toEqual([
        "legacy-csv-orphan-fingerprint",
      ]);

      const undo = await app.request(
        `/v1/finance/imports/${encodeURIComponent(legacy.importId)}`,
        { method: "DELETE" },
      );
      expect(undo.status).toBe(200);
      expect(await undo.json()).toEqual({
        ok: true,
        importId: legacy.importId,
        deletedTransactions: 1,
        deletedAccountId: legacy.accountId,
      });
      expect(importReceipt(legacy.importId)).toEqual({
        id: legacy.importId,
        source: "csv",
        accountId: null,
        status: "undone",
        importedCount: 0,
      });
      expect(accountRows()).toEqual([]);
      expect(transactionRows()).toEqual([]);
      expect(dependentAccountRows(legacy.accountId)).toEqual({
        balances: 0,
        history: 0,
      });
    });
  });

  test("manual link preserves the max occurrence count across providers", async () => {
    for (const scenario of [
      {
        name: "two CSV and two SnapTrade occurrences",
        csvCount: 2,
        snapCount: 2,
        expectedRows: 2,
        expectedMerged: 2,
      },
      {
        name: "one CSV and two SnapTrade occurrences",
        csvCount: 1,
        snapCount: 2,
        expectedRows: 2,
        expectedMerged: 1,
      },
    ]) {
      await withIsolatedGateway(async (app) => {
        const csvTransactions = Array.from(
          { length: scenario.csvCount },
          (_, index) =>
            csvTransaction(`csv-shared-${scenario.name}-${index + 1}`, {
              description: "Shared merchant",
              amount: -12.34,
            }),
        );
        const csv = await importCsvIntoNewAccount(app, {
          accountName: `Shared merchant CSV ${scenario.csvCount}`,
          accountType: "checking",
          accountCurrency: "CAD",
          transactions: csvTransactions,
        });
        const snapActivities = Array.from(
          { length: scenario.snapCount },
          (_, index) =>
            spendActivity(`snap-shared-${scenario.name}-${index + 1}`, {
              description: "Shared merchant",
              amount: 12.34,
            }),
        );
        await syncSnapTrade(app, snapActivities);

        const before = getFinanceDashboard();
        const canonical = before.accounts.find(
          (account) => account.source === "snaptrade",
        );
        expect(canonical).toBeDefined();
        expect(before.transactions).toHaveLength(
          scenario.csvCount + scenario.snapCount,
        );

        const linkResponse = await linkAccounts(
          app,
          canonical!.id,
          csv.accountId,
        );
        expect(linkResponse.status).toBe(201);
        const link = (await linkResponse.json()) as LinkResult;
        expect(link.transactionsMerged).toBe(scenario.expectedMerged);

        const after = getFinanceDashboard();
        expect(after.accounts.map((account) => account.id)).toEqual([
          canonical!.id,
        ]);
        expect(after.transactions).toHaveLength(scenario.expectedRows);
        expect(
          after.transactions.every(
            (transaction) => transaction.accountId === canonical!.id,
          ),
        ).toBe(true);
        expect(
          new Set(transactionRows().map((row) => row.dedupe_key)).size,
        ).toBe(scenario.expectedRows);
      });
    }
  });

  test("exact identity auto-link dedupes cross-source spends and ambiguity leaves candidates visible", async () => {
    await withIsolatedGateway(async (app) => {
      const account = await createManualAccount(app, {
        name: "Wealthsimple exact match",
        type: "checking",
        currency: "CAD",
      });
      setManualAccountIdentity(account.id, {
        institution: "Wealthsimple",
        mask: "4321",
      });
      const csv = await importCsv(
        app,
        csvImportBody({
          accountId: account.id,
          transactions: [csvTransaction("csv-auto-spend-1")],
        }),
      );

      const sync = await syncSnapTrade(app, [
        spendActivity("act-auto-spend-1"),
      ]);
      expect(sync).toMatchObject({
        accountsLinked: 1,
        transactions: 1,
        transactionsInserted: 0,
        transactionsSkipped: 1,
        warnings: [],
      });

      const dashboard = getFinanceDashboard();
      const canonical = dashboard.accounts[0];
      expect(dashboard.accounts).toHaveLength(1);
      expect(canonical).toMatchObject({
        source: "snaptrade",
        sourceId: "acc-wealthsimple-msb",
      });
      expect(dashboard.transactions).toHaveLength(1);
      expect(dashboard.transactions[0].accountId).toBe(canonical.id);
      expect(dashboard.transactions[0].source).toBe("csv");
      expect(linkRow(csv.accountId)).toEqual({
        canonical_account_id: canonical.id,
        method: "identity",
      });
    });

    await withIsolatedGateway(async (app) => {
      const first = await createManualAccount(app, {
        name: "Ambiguous cash A",
        type: "checking",
        currency: "CAD",
      });
      setManualAccountIdentity(first.id, {
        institution: "Wealthsimple",
        mask: "4321",
      });
      await importCsv(app, csvImportBody({ accountId: first.id }));
      const second = await createManualAccount(app, {
        name: "Ambiguous cash B",
        type: "checking",
        currency: "CAD",
      });
      setManualAccountIdentity(second.id, {
        institution: "Wealthsimple",
        mask: "4321",
      });
      await importCsv(app, csvImportBody({ accountId: second.id }));

      const sync = await syncSnapTrade(app, []);
      expect(sync.accountsLinked).toBe(0);
      expect(sync.warnings).toEqual([
        "Wealthsimple Trade MSB: multiple accounts match its identity; leaving unlinked",
      ]);
      expect(getFinanceDashboard().accounts).toHaveLength(3);
      expect(
        getDatabase()
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM finance_account_links",
          )
          .get()?.count,
      ).toBe(0);
    });
  });

  test("manual link route rejects invalid chains and unlink leaves merged transactions idempotent", async () => {
    await withIsolatedGateway(async (app) => {
      const canonical = await importCsvIntoNewAccount(app, {
        source: "manual",
        accountName: "Root CAD account",
        accountType: "checking",
        accountCurrency: "CAD",
        transactions: [
          csvTransaction("root-observable-tx", {
            description: "Root transaction",
            amount: -1,
          }),
        ],
      });
      const duplicateAccount = await createManualAccount(app, {
        name: "Duplicate CAD account",
        type: "checking",
        currency: "CAD",
      });
      const duplicateBody = csvImportBody({
        source: "manual",
        accountId: duplicateAccount.id,
        transactions: [
          csvTransaction("duplicate-observable-tx", {
            description: "Duplicate transaction",
            amount: -2,
          }),
        ],
      });
      const duplicate = await importCsv(app, duplicateBody);
      const otherCad = await importCsvIntoNewAccount(app, {
        source: "manual",
        accountName: "Other CAD account",
        accountType: "checking",
        accountCurrency: "CAD",
      });
      const usd = await importCsvIntoNewAccount(app, {
        source: "manual",
        accountName: "USD account",
        accountType: "checking",
        accountCurrency: "USD",
      });

      const linked = await linkAccounts(
        app,
        canonical.accountId,
        duplicate.accountId,
      );
      expect(linked.status).toBe(201);
      const linkedBody = (await linked.json()) as LinkResult;
      expect(linkedBody.canonicalAccountId).toBe(canonical.accountId);
      expect(linkedBody.duplicateAccountId).toBe(duplicate.accountId);
      expect(
        getFinanceDashboard().accounts.map((account) => account.id),
      ).not.toContain(duplicate.accountId);
      expect(
        transactionRows().find(
          (row) => row.fingerprint === "duplicate-observable-tx",
        )?.account_id,
      ).toBe(canonical.accountId);

      const repeat = await linkAccounts(
        app,
        canonical.accountId,
        duplicate.accountId,
      );
      expect(repeat.status).toBe(201);
      const repeatBody = (await repeat.json()) as LinkResult;
      expect(repeatBody.transactionsMerged).toBe(0);
      expect(repeatBody.transactionsRekeyed).toBe(0);

      const unknown = await linkAccounts(
        app,
        canonical.accountId,
        "missing-account",
      );
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: "account not found" });

      const sameAccount = await linkAccounts(
        app,
        canonical.accountId,
        canonical.accountId,
      );
      expect(sameAccount.status).toBe(400);
      expect(await sameAccount.json()).toEqual({
        error: "accounts must differ",
      });

      const currencyMismatch = await linkAccounts(
        app,
        canonical.accountId,
        usd.accountId,
      );
      expect(currencyMismatch.status).toBe(409);
      expect(await currencyMismatch.json()).toEqual({
        error: "account currencies must match",
      });

      const duplicateAlreadyLinked = await linkAccounts(
        app,
        otherCad.accountId,
        duplicate.accountId,
      );
      expect(duplicateAlreadyLinked.status).toBe(409);
      expect(await duplicateAlreadyLinked.json()).toEqual({
        error: "duplicate account is already linked",
      });

      const linkToShadow = await linkAccounts(
        app,
        duplicate.accountId,
        otherCad.accountId,
      );
      expect(linkToShadow.status).toBe(409);
      expect(await linkToShadow.json()).toEqual({
        error: "link to the root account",
      });

      const duplicateIsCanonical = await linkAccounts(
        app,
        otherCad.accountId,
        canonical.accountId,
      );
      expect(duplicateIsCanonical.status).toBe(409);
      expect(await duplicateIsCanonical.json()).toEqual({
        error: "unlink its duplicates first",
      });

      const unlink = await app.request(
        `/v1/finance/accounts/links/${encodeURIComponent(duplicate.accountId)}`,
        { method: "DELETE" },
      );
      expect(unlink.status).toBe(200);
      expect(await unlink.json()).toEqual({
        unlinked: true,
        accountId: duplicate.accountId,
      });
      expect(
        getFinanceDashboard().accounts.map((account) => account.id),
      ).toContain(duplicate.accountId);
      expect(
        transactionRows().find(
          (row) => row.fingerprint === "duplicate-observable-tx",
        )?.account_id,
      ).toBe(canonical.accountId);

      const reimportDuplicate = await importCsv(app, duplicateBody);
      expect(reimportDuplicate.accountId).toBe(duplicate.accountId);
      expect(reimportDuplicate.imported).toBe(0);
      expect(reimportDuplicate.skippedDuplicates).toBe(1);
      expect(
        transactionRows().filter(
          (row) => row.fingerprint === "duplicate-observable-tx",
        ),
      ).toHaveLength(1);

      const secondUnlink = await app.request(
        `/v1/finance/accounts/links/${encodeURIComponent(duplicate.accountId)}`,
        { method: "DELETE" },
      );
      expect(secondUnlink.status).toBe(404);
      expect(await secondUnlink.json()).toEqual({ error: "link not found" });
    });
  });

  test("manual account PATCH renames, edits balance, and records current-day history", async () => {
    await withIsolatedGateway(async (app) => {
      const manual = await createManualAccount(app, {
        name: "Old Cash",
        type: "checking",
        currency: "CAD",
        balance: 100,
      });

      const response = await app.request(
        `/v1/finance/accounts/${encodeURIComponent(manual.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "  Emergency Cash  ", balance: 321.45 }),
        },
      );

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        ok: true;
        account: ManualAccount;
      };
      expect(payload.account.name).toBe("Emergency Cash");
      expect(payload.account.balance).toBe(321.45);
      expect(payload.account.currency).toBe("CAD");

      const history = accountHistoryRows(manual.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        account_id: manual.id,
        source: "manual",
        date: new Date().toISOString().slice(0, 10),
        equity: 321.45,
        cash: null,
        currency: "CAD",
      });
    });
  });

  test("manual account PATCH balance null clears balance without adding history", async () => {
    await withIsolatedGateway(async (app) => {
      const manual = await createManualAccount(app, {
        name: "Nullable Cash",
        balance: 44,
      });
      const before = accountHistoryRows(manual.id);

      const response = await app.request(
        `/v1/finance/accounts/${encodeURIComponent(manual.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ balance: null }),
        },
      );

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        ok: true;
        account: ManualAccount;
      };
      expect(payload.account.balance).toBeNull();
      expect(accountHistoryRows(manual.id)).toEqual(before);
    });
  });

  test("account PATCH rejects provider name edits but allows provider status updates", async () => {
    await withIsolatedGateway(async (app) => {
      await syncSnapTrade(app, []);
      const snaptradeAccount = getFinanceDashboard().accounts.find(
        (account) => account.source === "snaptrade",
      );
      if (!snaptradeAccount) throw new Error("expected SnapTrade account");

      const rejectName = await app.request(
        `/v1/finance/accounts/${encodeURIComponent(snaptradeAccount.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Edited Provider Account" }),
        },
      );
      expect(rejectName.status).toBe(409);
      expect(await rejectName.json()).toEqual({
        error: "only manual accounts can be edited",
      });

      const hide = await app.request(
        `/v1/finance/accounts/${encodeURIComponent(snaptradeAccount.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "hidden" }),
        },
      );
      expect(hide.status).toBe(200);
      const payload = (await hide.json()) as {
        ok: true;
        account: ManualAccount & { status: string | null };
      };
      expect(payload.account.status).toBe("hidden");
    });
  });

  test("account PATCH validates empty names, empty patches, and missing accounts", async () => {
    await withIsolatedGateway(async (app) => {
      const manual = await createManualAccount(app, {
        name: "Validation Cash",
      });

      const emptyName = await app.request(
        `/v1/finance/accounts/${encodeURIComponent(manual.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "   " }),
        },
      );
      expect(emptyName.status).toBe(400);
      expect(await emptyName.json()).toEqual({
        error: "account name is required",
      });

      const emptyPatch = await app.request(
        `/v1/finance/accounts/${encodeURIComponent(manual.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(emptyPatch.status).toBe(400);

      const missing = await app.request(
        "/v1/finance/accounts/missing-account",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Missing" }),
        },
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "account not found" });
    });
  });

  test("account lifecycle routes hide, unhide, delete manual accounts, and reject provider deletes", async () => {
    await withIsolatedGateway(async (app) => {
      const manual = await createManualAccount(app, {
        name: "Lifecycle Cash",
        type: "checking",
        currency: "CAD",
        balance: 250,
      });
      const imported = await importCsv(
        app,
        csvImportBody({
          accountId: manual.id,
          source: "manual",
          transactions: [
            csvTransaction("lifecycle-delete-1", { amount: -12 }),
            csvTransaction("lifecycle-delete-2", { amount: -13 }),
          ],
        }),
      );
      expect(imported.imported).toBe(2);

      const hide = await app.request(
        `/v1/finance/accounts/${encodeURIComponent(manual.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "hidden" }),
        },
      );
      expect(hide.status).toBe(200);
      type AccountStatusResponse = {
        ok: true;
        account: ManualAccount & { status: string | null };
      };
      const hiddenPayload = (await hide.json()) as AccountStatusResponse;
      expect(hiddenPayload.account.status).toBe("hidden");
      expect(
        getFinanceDashboard().accounts.find(
          (account) => account.id === manual.id,
        )?.status,
      ).toBe("hidden");

      const unhide = await app.request(
        `/v1/finance/accounts/${encodeURIComponent(manual.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "active" }),
        },
      );
      expect(unhide.status).toBe(200);
      const activePayload = (await unhide.json()) as AccountStatusResponse;
      expect(activePayload.account.status).toBe("active");

      const invalidStatus = await app.request(
        `/v1/finance/accounts/${encodeURIComponent(manual.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "archived" }),
        },
      );
      expect(invalidStatus.status).toBe(400);

      await syncSnapTrade(app, []);
      const snaptradeAccount = getFinanceDashboard().accounts.find(
        (account) => account.source === "snaptrade",
      );
      if (!snaptradeAccount) throw new Error("expected SnapTrade account");
      const rejectProviderDelete = await app.request(
        `/v1/finance/accounts/${encodeURIComponent(snaptradeAccount.id)}`,
        { method: "DELETE" },
      );
      expect(rejectProviderDelete.status).toBe(409);
      expect(await rejectProviderDelete.json()).toEqual({
        error: "only manual accounts can be deleted",
      });

      const remove = await app.request(
        `/v1/finance/accounts/${encodeURIComponent(manual.id)}`,
        { method: "DELETE" },
      );
      expect(remove.status).toBe(200);
      expect(await remove.json()).toEqual({
        ok: true,
        accountId: manual.id,
        deletedTransactions: 2,
      });
      expect(
        getFinanceDashboard().accounts.map((account) => account.id),
      ).not.toContain(manual.id);
      expect(
        transactionRows().filter((row) => row.account_id === manual.id),
      ).toHaveLength(0);
    });
  });
});
