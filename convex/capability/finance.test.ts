import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

async function owner() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { email: "owner@example.test" }),
  );
  const client = t.withIdentity({ subject: userId });
  const workspaceId = await client.mutation(api.platform.workspace.ensureDefault, {});
  return { t, client, workspaceId };
}
afterEach(() => {
  vi.restoreAllMocks();
});


describe("Finance capabilities", () => {
  it("aggregates canonical balances with exact fixed-point arithmetic", async () => {
    const { client } = await owner();
    await client.mutation(api.capability.finance.saveAccount, {
      name: "Wallet A",
      type: "cash",
      currency: "BTC",
      balance: "0.10000000",
    });
    await client.mutation(api.capability.finance.saveAccount, {
      name: "Wallet B",
      type: "cash",
      currency: "btc",
      balance: "0.20000000",
    });

    const dashboard = await client.query(api.capability.finance.dashboard, {});
    expect(dashboard.totalsByCurrency).toEqual([
      { currency: "BTC", balance: "0.3" },
    ]);
    expect(dashboard.accounts.map((account) => account.balance)).toEqual([
      "0.2",
      "0.1",
    ]);
  });

  it("converts every monetary record into the requested reporting currency", async () => {
    const { client } = await owner();
    await client.mutation(api.capability.finance.saveAccount, {
      name: "USD account",
      type: "checking",
      currency: "USD",
      balance: "100",
    });
    await client.mutation(api.capability.finance.saveAccount, {
      name: "CAD account",
      type: "checking",
      currency: "CAD",
      balance: "50",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: { CAD: 1.25 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const dashboard = (await client.action(api.product.web.finance.dashboard, {
      currency: "CAD",
    })) as {
      accounts: Array<{ currency: string; balance: string }>;
      totalsByCurrency: Array<{ currency: string; balance: string }>;
      conversion: { currency: string; providers: string[] };
    };

    expect(dashboard.accounts.map((account) => account.currency)).toEqual([
      "CAD",
      "CAD",
    ]);
    expect(dashboard.accounts.map((account) => account.balance)).toEqual([
      "50",
      "125",
    ]);
    expect(dashboard.totalsByCurrency).toEqual([
      { currency: "CAD", balance: "175" },
    ]);
    expect(dashboard.conversion).toMatchObject({
      currency: "CAD",
      providers: ["frankfurter"],
    });
  });

  it("converts Bitcoin using the provider's USD-per-BTC quote direction", async () => {
    const { client } = await owner();
    await client.mutation(api.capability.finance.saveAccount, {
      name: "Bitcoin",
      type: "crypto",
      currency: "BTC",
      balance: "1",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ bitcoin: { usd: 60_000 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const dashboard = (await client.action(api.product.web.finance.dashboard, {
      currency: "USD",
    })) as { accounts: Array<{ balance: string }> };

    expect(dashboard.accounts[0]?.balance).toBe("60000");
  });

  it("carries sparse account history forward and subtracts liabilities", async () => {
    const { t, client, workspaceId } = await owner();
    const assetId = await client.mutation(api.capability.finance.saveAccount, {
      name: "Savings",
      type: "savings",
      currency: "CAD",
    });
    const loanId = await client.mutation(api.capability.finance.saveAccount, {
      name: "Loan",
      type: "loan",
      currency: "CAD",
    });
    await t.run(async (ctx) => {
      const rows = [
        { accountId: assetId, date: "2026-01-01", equity: 100n },
        { accountId: loanId, date: "2026-01-01", equity: 20n },
        { accountId: assetId, date: "2026-01-02", equity: 110n },
      ];
      for (const [index, row] of rows.entries()) {
        await ctx.db.insert("financeAccountValueHistory", {
          workspaceId,
          accountId: row.accountId,
          source: "manual",
          date: row.date,
          equity: { units: row.equity, scale: 0 },
          currency: "CAD",
          observedAt: index,
          createdAt: index,
          updatedAt: index,
        });
      }
    });

    const dashboard = (await client.action(api.product.web.finance.dashboard, {
      currency: "CAD",
    })) as { valueHistory: Array<{ date: string; equity: string }> };

    expect(dashboard.valueHistory).toEqual([
      expect.objectContaining({ date: "2026-01-01", equity: "80" }),
      expect.objectContaining({ date: "2026-01-02", equity: "90" }),
    ]);
  });

  it("upserts transactions by a stable dedupe key", async () => {
    const { client } = await owner();
    const accountId = await client.mutation(api.capability.finance.saveAccount, {
      name: "Checking",
      type: "checking",
      currency: "CAD",
    });
    const firstId = await client.mutation(api.capability.finance.saveTransaction, {
      accountId,
      dedupeKey: "statement:42",
      description: "Coffee",
      amount: "-4.25",
      currency: "CAD",
      postedAt: 1_000,
    });
    const secondId = await client.mutation(api.capability.finance.saveTransaction, {
      accountId,
      dedupeKey: "statement:42",
      description: "Coffee corrected",
      amount: "-4.50",
      currency: "CAD",
      postedAt: 1_000,
    });
    expect(secondId).toBe(firstId);
    const rows = await client.query(api.capability.finance.listTransactions, { accountId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: "Coffee corrected", amount: "-4.5" });
  });

  it("imports CSV rows in resumable idempotent batches", async () => {
    const { t, client } = await owner();
    const accountId = await client.mutation(api.capability.finance.saveAccount, {
      name: "Imported",
      type: "checking",
      currency: "CAD",
    });
    const storageId = await t.run((ctx) =>
      ctx.storage.store(
        new Blob([
          'Date,Description,Amount,Currency,Category\n2026-01-01,"Coffee, shop",-4.25,CAD,Food\n2026-01-02,Salary,1000.00,CAD,Income\n',
        ]),
      ),
    );
    const args = {
      accountId,
      storageId,
      idempotencyKey: "csv-file-1",
      mapping: {
        dateColumn: "Date",
        descriptionColumn: "Description",
        amountColumn: "Amount",
        currencyColumn: "Currency",
        categoryColumn: "Category",
        defaultCurrency: "CAD",
      },
    };
    const result = await client.action(api.capability.finance.import.importCsv, args);
    expect(result).toMatchObject({ applied: 2, skipped: 0 });
    const repeated = await client.action(api.capability.finance.import.importCsv, args);
    expect(repeated).toMatchObject({ applied: 0, skipped: 0 });

    const rows = await client.query(api.capability.finance.listTransactions, { accountId });
    expect(rows.map((row) => row.amount)).toEqual(["1000", "-4.25"]);
    const jobs = await t.run((ctx) => ctx.db.query("financeImportJobs").collect());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "completed", appliedCount: 2 });
  });

  it("keeps the same instrument distinct across brokerage accounts", async () => {
    const { t, client, workspaceId } = await owner();
    const firstAccountId = await client.mutation(api.capability.finance.saveAccount, {
      name: "Brokerage A",
      type: "investment",
      currency: "USD",
    });
    const secondAccountId = await client.mutation(api.capability.finance.saveAccount, {
      name: "Brokerage B",
      type: "investment",
      currency: "USD",
    });
    for (const accountId of [firstAccountId, secondAccountId]) {
      await t.mutation(internal.capability.integration.applySnapTradeAccountData, {
        workspaceId,
        system: true,
        accountId,
        balances: [],
        positions: [
          {
            sourceId: "instrument-42",
            symbol: "XYZ",
            quantity: "1",
            currency: "USD",
          },
        ],
        activities: [],
        history: [],
        returnRates: [],
      });
    }
    const positions = await t.run((ctx) => ctx.db.query("financePositions").collect());
    expect(positions).toHaveLength(2);
    expect(new Set(positions.map((position) => position.accountId))).toEqual(
      new Set([firstAccountId, secondAccountId]),
    );
  });

  it("rejects monetary values outside signed int64 storage", async () => {
    const { client } = await owner();
    await expect(
      client.mutation(api.capability.finance.saveAccount, {
        name: "Impossible",
        type: "cash",
        currency: "CAD",
        balance: "9223372036854775808",
      }),
    ).rejects.toThrow("exceeds the supported exact range");
  });
});
