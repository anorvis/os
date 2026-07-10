import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase, resetDatabaseForTests } from "../src/core/db/database";

type AccountRow = {
  id: string;
  type: string;
};

type ActivityRow = {
  id: string;
  accountId: string | null;
  type: string;
  amount: number | null;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
};

type CategoryRow = {
  id: string;
  name: string;
  groupName: string;
  excludeFromSpending: number;
};

type TransactionRow = {
  id: string;
  accountId: string | null;
  source: string;
  sourceId: string | null;
  fingerprint: string;
  description: string;
  amount: number;
  currency: string;
  postedAt: string;
  categoryId: string | null;
  status: string;
  sourceVariant: string | null;
};

type EnvironmentSnapshot = {
  HOME: string | undefined;
  ANORVIS_DB_PATH: string | undefined;
  ANORVIS_OS_API_TOKEN: string | undefined;
  ANORVIS_OS_API_TOKEN_PATH: string | undefined;
};

describe("database finance migrations", () => {
  test("migration 21 promotes stale Wealthsimple MSB card spends and preserves investment-shaped activity", async () => {
    await withIsolatedMigrationDatabase(() => {
      seedVersion20SnapTradeSpendState();

      const db = getDatabase();
      const accounts = db
        .query<AccountRow, []>(
          `
          SELECT id, type
          FROM finance_accounts
          WHERE source = 'snaptrade'
          ORDER BY id ASC
        `,
        )
        .all();
      const category =
        db
          .query<CategoryRow, []>(
            `
            SELECT
              id,
              name,
              group_name AS groupName,
              exclude_from_spending AS excludeFromSpending
            FROM finance_categories
            WHERE id = 'card-spend'
          `,
          )
          .get() ?? null;
      const transactions = db
        .query<TransactionRow, []>(
          `
          SELECT
            id,
            account_id AS accountId,
            source,
            source_id AS sourceId,
            fingerprint,
            description,
            amount,
            currency,
            posted_at AS postedAt,
            category_id AS categoryId,
            status,
            source_variant AS sourceVariant
          FROM finance_transactions
          WHERE source = 'snaptrade'
          ORDER BY posted_at DESC, id ASC
        `,
        )
        .all();
      const activities = db
        .query<ActivityRow, []>(
          `
          SELECT
            id,
            account_id AS accountId,
            type,
            amount,
            symbol,
            quantity,
            price
          FROM finance_activities
          WHERE source = 'snaptrade'
          ORDER BY id ASC
        `,
        )
        .all();

      expect(
        db
          .query<{ applied: number }, []>(
            "SELECT COUNT(*) AS applied FROM schema_migrations WHERE version = 21",
          )
          .get()?.applied,
      ).toBe(1);
      expect(accounts).toEqual([
        { id: "acct-msb", type: "checking" },
        { id: "acct-rrsp", type: "investment" },
      ]);
      expect(category).toEqual({
        id: "card-spend",
        name: "card spend",
        groupName: "spending",
        excludeFromSpending: 0,
      });
      expect(transactions).toEqual([
        {
          id: "promoted:act-card-reversal",
          accountId: "acct-msb",
          source: "snaptrade",
          sourceId: "snaptrade-card-reversal",
          fingerprint: "snaptrade:card-reversal",
          description: "Returned card purchase",
          amount: 4.56,
          currency: "CAD",
          postedAt: "2026-01-03T10:00:00.000Z",
          categoryId: "card-spend",
          status: "posted",
          sourceVariant: "wealthsimple",
        },
        {
          id: "promoted:act-card-spend",
          accountId: "acct-msb",
          source: "snaptrade",
          sourceId: "snaptrade-card-spend",
          fingerprint: "snaptrade:card-spend",
          description: "Coffee card purchase",
          amount: -12.34,
          currency: "CAD",
          postedAt: "2026-01-02T10:00:00.000Z",
          categoryId: "card-spend",
          status: "posted",
          sourceVariant: "wealthsimple",
        },
      ]);
      expect(activities).toEqual([
        {
          id: "act-investment-spend",
          accountId: "acct-rrsp",
          type: "SPEND",
          amount: 7.89,
          symbol: null,
          quantity: null,
          price: null,
        },
        {
          id: "act-security-spend",
          accountId: "acct-msb",
          type: "SPEND",
          amount: 99,
          symbol: "AAPL",
          quantity: 1,
          price: 99,
        },
      ]);
    });
  });
});

async function withIsolatedMigrationDatabase(
  run: () => void | Promise<void>,
): Promise<void> {
  const environment: EnvironmentSnapshot = {
    HOME: process.env.HOME,
    ANORVIS_DB_PATH: process.env.ANORVIS_DB_PATH,
    ANORVIS_OS_API_TOKEN: process.env.ANORVIS_OS_API_TOKEN,
    ANORVIS_OS_API_TOKEN_PATH: process.env.ANORVIS_OS_API_TOKEN_PATH,
  };
  const home = mkdtempSync(join(tmpdir(), "anorvis-finance-migration-"));
  process.env.HOME = home;
  process.env.ANORVIS_DB_PATH = join(home, "anorvis.sqlite");
  delete process.env.ANORVIS_OS_API_TOKEN;
  delete process.env.ANORVIS_OS_API_TOKEN_PATH;
  resetDatabaseForTests();

  try {
    await run();
  } finally {
    resetDatabaseForTests();
    restoreEnvironment(environment);
  }
}

function seedVersion20SnapTradeSpendState(): void {
  const db = getDatabase();
  db.exec(`
    DELETE FROM finance_account_return_rates;
    DELETE FROM finance_account_value_history;
    DELETE FROM finance_balances;
    DELETE FROM finance_positions;
    DELETE FROM finance_transactions;
    DELETE FROM finance_activities;
    DELETE FROM finance_imports;
    DELETE FROM finance_accounts;
    DELETE FROM finance_categories WHERE id = 'card-spend';
    DELETE FROM schema_migrations WHERE version >= 21;

    INSERT INTO finance_accounts (
      id, source, source_id, name, type, currency, balance, created_at, updated_at,
      source_variant, institution, mask, status, observed_at
    ) VALUES
      (
        'acct-msb', 'snaptrade', 'acc-wealthsimple-msb', 'Wealthsimple Trade MSB',
        'investment', 'CAD', 742.13, '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', 'wealthsimple', 'Wealthsimple', '4321',
        'active', '2026-01-01T00:00:00.000Z'
      ),
      (
        'acct-rrsp', 'snaptrade', 'acc-wealthsimple-rrsp', 'Wealthsimple RRSP',
        'investment', 'CAD', 15250.75, '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', 'wealthsimple', 'Wealthsimple', '9012',
        'active', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO finance_activities (
      id, account_id, source, source_id, source_variant, type, description, amount,
      currency, symbol, quantity, price, fingerprint, status, occurred_at, settled_at,
      created_at, updated_at
    ) VALUES
      (
        'act-card-spend', 'acct-msb', 'snaptrade', 'snaptrade-card-spend',
        'wealthsimple', 'SPEND', 'Coffee card purchase', 12.34, 'cad', NULL, NULL,
        NULL, 'snaptrade:card-spend', 'posted', '2026-01-02T10:00:00.000Z', NULL,
        '2026-01-02T10:01:00.000Z', '2026-01-02T10:01:00.000Z'
      ),
      (
        'act-card-reversal', 'acct-msb', 'snaptrade', 'snaptrade-card-reversal',
        'wealthsimple', 'SPEND', 'Returned card purchase', -4.56, 'CAD', NULL, NULL,
        NULL, 'snaptrade:card-reversal', 'posted', '2026-01-03T10:00:00.000Z', NULL,
        '2026-01-03T10:01:00.000Z', '2026-01-03T10:01:00.000Z'
      ),
      (
        'act-security-spend', 'acct-msb', 'snaptrade', 'snaptrade-security-spend',
        'wealthsimple', 'SPEND', 'Security-shaped spend stays activity', 99, 'CAD',
        'AAPL', 1, 99, 'snaptrade:security-spend', 'posted',
        '2026-01-04T10:00:00.000Z', NULL, '2026-01-04T10:01:00.000Z',
        '2026-01-04T10:01:00.000Z'
      ),
      (
        'act-investment-spend', 'acct-rrsp', 'snaptrade', 'snaptrade-investment-spend',
        'wealthsimple', 'SPEND', 'Investment account spend stays activity', 7.89,
        'CAD', NULL, NULL, NULL, 'snaptrade:investment-spend', 'posted',
        '2026-01-05T10:00:00.000Z', NULL, '2026-01-05T10:01:00.000Z',
        '2026-01-05T10:01:00.000Z'
      );
  `);
  resetDatabaseForTests();
}

function restoreEnvironment(environment: EnvironmentSnapshot): void {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
