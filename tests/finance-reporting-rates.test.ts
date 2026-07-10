import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getFinanceReportingDashboard,
  setFinanceRateFetch,
} from "../src/capability/finance/rates";
import {
  createFinanceAccount,
  updateFinanceAccount,
  upsertFinanceAccount,
  upsertFinanceAccountHistory,
} from "../src/capability/finance/data";
import { resetDatabaseForTests } from "../src/core/db/database";

async function withIsolatedFinanceData(
  run: () => Promise<void>,
): Promise<void> {
  const environment = new Map<string, string | undefined>([
    ["HOME", process.env.HOME],
    ["ANORVIS_DB_PATH", process.env.ANORVIS_DB_PATH],
  ]);
  const home = mkdtempSync(join(tmpdir(), "anorvis-finance-reporting-"));
  process.env.HOME = home;
  process.env.ANORVIS_DB_PATH = join(home, ".anorvis", "data", "test.sqlite");
  resetDatabaseForTests();
  setFinanceRateFetch(null);

  try {
    await run();
  } finally {
    setFinanceRateFetch(null);
    restoreEnvironment(environment);
    resetDatabaseForTests();
  }
}

function restoreEnvironment(
  environment: Map<string, string | undefined>,
): void {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

type RateMockState = {
  requests: string[];
  frankfurter: number;
};

type RateHandlers = {
  frankfurter?: (url: URL, call: number) => Response;
};

// Replaces the exchange-rate transport with a stub that records every request
// and answers Frankfurter fiat lookups. A request without a handler throws, so
// an accidental live-network fetch fails the test instead of hitting the net.
function installRateTransport(handlers: RateHandlers): RateMockState {
  const state: RateMockState = { requests: [], frankfurter: 0 };
  setFinanceRateFetch((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    state.requests.push(url.toString());
    if (url.hostname.includes("frankfurter")) {
      state.frankfurter += 1;
      if (!handlers.frankfurter) {
        throw new Error(`unexpected Frankfurter request: ${url.toString()}`);
      }
      return Promise.resolve(handlers.frankfurter(url, state.frankfurter));
    }
    throw new Error(`unexpected rate host: ${url.hostname}`);
  });
  return state;
}

function frankfurterOk(
  rows: Array<{ quote: string; rate: number; date: string }>,
): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("finance reporting dashboard history aggregation", () => {
  test("forward-fills staggered account history and converts each account before summing into the reporting currency", async () => {
    await withIsolatedFinanceData(async () => {
      const now = new Date("2026-01-04T12:00:00.000Z");
      const usdAccountId = upsertFinanceAccount(
        {
          source: "snaptrade",
          sourceId: "usd-account",
          sourceVariant: "broker-a",
          name: "USD Brokerage",
          type: "investment",
          currency: "USD",
          balance: 130,
          status: "active",
          observedAt: now.toISOString(),
        },
        now,
      );
      const cadAccountId = upsertFinanceAccount(
        {
          source: "snaptrade",
          sourceId: "cad-account",
          sourceVariant: "broker-b",
          name: "CAD Brokerage",
          type: "investment",
          currency: "CAD",
          balance: 300,
          status: "active",
          observedAt: now.toISOString(),
        },
        now,
      );

      for (const point of [
        {
          accountId: usdAccountId,
          date: "2026-01-01",
          equity: 100,
          cash: 10,
          currency: "USD",
        },
        {
          accountId: cadAccountId,
          date: "2026-01-02",
          equity: 260,
          cash: 26,
          currency: "CAD",
        },
        {
          accountId: usdAccountId,
          date: "2026-01-03",
          equity: 130,
          cash: 13,
          currency: "USD",
        },
        {
          accountId: cadAccountId,
          date: "2026-01-04",
          equity: 300,
          cash: null,
          currency: "CAD",
        },
      ]) {
        upsertFinanceAccountHistory(
          {
            source: "snaptrade",
            sourceVariant: "broker-history",
            importId: null,
            observedAt: now.toISOString(),
            ...point,
          },
          now,
        );
      }

      const rateRequests: string[] = [];
      setFinanceRateFetch((input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        rateRequests.push(url.toString());
        expect(url.searchParams.get("base")).toBe("USD");
        expect(url.searchParams.get("quotes")).toBe("CAD");
        return Promise.resolve(
          new Response(
            JSON.stringify([{ quote: "CAD", rate: 1.3, date: "2026-01-04" }]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      });

      const dashboard = await getFinanceReportingDashboard("USD", now);

      expect(rateRequests).toHaveLength(1);
      expect(dashboard.conversion).toMatchObject({
        currency: "USD",
        asOf: "2026-01-04",
        providers: ["Frankfurter / ECB"],
        stale: false,
      });
      expect(
        dashboard.history.map(({ accountId, date, currency, source }) => ({
          accountId,
          date,
          currency,
          source,
        })),
      ).toEqual([
        {
          accountId: null,
          date: "2026-01-01",
          currency: "USD",
          source: "portfolio",
        },
        {
          accountId: null,
          date: "2026-01-02",
          currency: "USD",
          source: "portfolio",
        },
        {
          accountId: null,
          date: "2026-01-03",
          currency: "USD",
          source: "portfolio",
        },
        {
          accountId: null,
          date: "2026-01-04",
          currency: "USD",
          source: "portfolio",
        },
      ]);

      expect(dashboard.history[0].equity).toBe(100);
      expect(dashboard.history[0].cash).toBe(10);
      expect(dashboard.history[1].equity).toBe(300);
      expect(dashboard.history[1].cash).toBe(30);
      expect(dashboard.history[2].equity).toBe(330);
      expect(dashboard.history[2].cash).toBe(33);
      expect(dashboard.history[3].equity).toBeCloseTo(360.769230769, 9);
      expect(dashboard.history[3].cash).toBe(13);
    });
  });

  test("sums checking and investment account equity as assets and forward-fills each account from its first observation", async () => {
    await withIsolatedFinanceData(async () => {
      const now = new Date("2026-01-04T12:00:00.000Z");
      const checkingId = upsertFinanceAccount(
        {
          source: "snaptrade",
          sourceId: "chk",
          name: "Checking",
          type: "checking",
          currency: "USD",
          balance: 1000,
          status: "active",
          observedAt: now.toISOString(),
        },
        now,
      );
      const investmentId = upsertFinanceAccount(
        {
          source: "snaptrade",
          sourceId: "inv",
          name: "Investment",
          type: "investment",
          currency: "USD",
          balance: 5000,
          status: "active",
          observedAt: now.toISOString(),
        },
        now,
      );
      upsertFinanceAccountHistory(
        {
          accountId: checkingId,
          source: "snaptrade",
          date: "2026-01-01",
          equity: 1000,
          cash: 1000,
          currency: "USD",
        },
        now,
      );
      upsertFinanceAccountHistory(
        {
          accountId: investmentId,
          source: "snaptrade",
          date: "2026-01-03",
          equity: 5000,
          cash: 200,
          currency: "USD",
        },
        now,
      );

      // Reporting currency matches every source, so conversion is skipped and
      // no rate transport call may happen.
      const rates = installRateTransport({});
      const dashboard = await getFinanceReportingDashboard("USD", now);

      expect(rates.requests).toEqual([]);
      expect(dashboard.history).toHaveLength(2);
      // Only the checking account has been observed on its first date.
      expect(dashboard.history[0]).toMatchObject({
        accountId: null,
        date: "2026-01-01",
        source: "portfolio",
      });
      expect(dashboard.history[0].equity).toBe(1000);
      expect(dashboard.history[0].cash).toBe(1000);
      // The checking account forward-fills; the investment account is added.
      expect(dashboard.history[1]).toMatchObject({ date: "2026-01-03" });
      expect(dashboard.history[1].equity).toBe(6000);
      expect(dashboard.history[1].cash).toBe(1200);
    });
  });

  test("excludes hidden accounts from reporting history until they are active again", async () => {
    await withIsolatedFinanceData(async () => {
      const now = new Date("2026-01-04T12:00:00.000Z");
      const visibleId = upsertFinanceAccount(
        {
          source: "snaptrade",
          sourceId: "visible",
          name: "Visible Brokerage",
          type: "investment",
          currency: "USD",
          balance: 1000,
          status: "active",
          observedAt: now.toISOString(),
        },
        now,
      );
      const hiddenId = upsertFinanceAccount(
        {
          source: "snaptrade",
          sourceId: "hidden",
          name: "Hidden Brokerage",
          type: "investment",
          currency: "USD",
          balance: 4000,
          status: "active",
          observedAt: now.toISOString(),
        },
        now,
      );
      for (const accountId of [visibleId, hiddenId]) {
        upsertFinanceAccountHistory(
          {
            accountId,
            source: "snaptrade",
            date: "2026-01-01",
            equity: accountId === visibleId ? 1000 : 4000,
            cash: 0,
            currency: "USD",
          },
          now,
        );
      }
      updateFinanceAccount(hiddenId, { status: "hidden" }, now);

      const hiddenDashboard = await getFinanceReportingDashboard("USD", now);
      expect(hiddenDashboard.history).toHaveLength(1);
      expect(hiddenDashboard.history[0].equity).toBe(1000);

      updateFinanceAccount(hiddenId, { status: "active" }, now);
      const restoredDashboard = await getFinanceReportingDashboard("USD", now);
      expect(restoredDashboard.history).toHaveLength(1);
      expect(restoredDashboard.history[0].equity).toBe(5000);
    });
  });

  test("subtracts credit and loan liabilities by absolute value regardless of the stored sign", async () => {
    await withIsolatedFinanceData(async () => {
      const now = new Date("2026-02-01T12:00:00.000Z");
      const checkingId = upsertFinanceAccount(
        {
          source: "snaptrade",
          sourceId: "chk",
          name: "Checking",
          type: "checking",
          currency: "USD",
          balance: 2000,
          status: "active",
          observedAt: now.toISOString(),
        },
        now,
      );
      const creditId = upsertFinanceAccount(
        {
          source: "snaptrade",
          sourceId: "cc",
          name: "Credit Card",
          type: "credit",
          currency: "USD",
          balance: -500,
          status: "active",
          observedAt: now.toISOString(),
        },
        now,
      );
      const loanId = upsertFinanceAccount(
        {
          source: "snaptrade",
          sourceId: "ln",
          name: "Auto Loan",
          type: "loan",
          currency: "USD",
          balance: 300,
          status: "active",
          observedAt: now.toISOString(),
        },
        now,
      );
      for (const point of [
        { accountId: checkingId, equity: 2000 },
        { accountId: creditId, equity: -500 },
        { accountId: loanId, equity: 300 },
      ]) {
        upsertFinanceAccountHistory(
          {
            source: "snaptrade",
            date: "2026-02-01",
            cash: null,
            currency: "USD",
            ...point,
          },
          now,
        );
      }

      installRateTransport({});
      const dashboard = await getFinanceReportingDashboard("USD", now);

      expect(dashboard.history).toHaveLength(1);
      // 2000 asset - |-500| credit - |300| loan = 1200: both a negative and a
      // positive liability subtract their magnitude.
      expect(dashboard.history[0].equity).toBe(1200);
      expect(dashboard.history[0].date).toBe("2026-02-01");
    });
  });

  test("converts each account to the reporting currency before applying the liability sign and summing", async () => {
    await withIsolatedFinanceData(async () => {
      const now = new Date("2026-03-01T12:00:00.000Z");
      const usdCheckingId = upsertFinanceAccount(
        {
          source: "snaptrade",
          sourceId: "usd-chk",
          name: "USD Checking",
          type: "checking",
          currency: "USD",
          balance: 500,
          status: "active",
          observedAt: now.toISOString(),
        },
        now,
      );
      const cadCreditId = upsertFinanceAccount(
        {
          source: "snaptrade",
          sourceId: "cad-cc",
          name: "CAD Credit",
          type: "credit",
          currency: "CAD",
          balance: 1300,
          status: "active",
          observedAt: now.toISOString(),
        },
        now,
      );
      upsertFinanceAccountHistory(
        {
          accountId: usdCheckingId,
          source: "snaptrade",
          date: "2026-03-01",
          equity: 500,
          cash: null,
          currency: "USD",
        },
        now,
      );
      upsertFinanceAccountHistory(
        {
          accountId: cadCreditId,
          source: "snaptrade",
          date: "2026-03-01",
          equity: 1300,
          cash: null,
          currency: "CAD",
        },
        now,
      );

      const rates = installRateTransport({
        frankfurter: () =>
          frankfurterOk([{ quote: "CAD", rate: 1.3, date: "2026-03-01" }]),
      });
      const dashboard = await getFinanceReportingDashboard("USD", now);

      expect(rates.frankfurter).toBe(1);
      expect(dashboard.history).toHaveLength(1);
      // 500 USD asset - |1300 CAD -> 1000 USD| = -500 USD. Summing the raw CAD
      // magnitude (1300) without converting first would give -800.
      expect(dashboard.history[0].equity).toBeCloseTo(-500, 6);
      expect(dashboard.conversion.currency).toBe("USD");
      expect(dashboard.conversion.providers).toEqual(["Frankfurter / ECB"]);
    });
  });

  test("treats a manual account's opening balance as its single current net-worth point", async () => {
    await withIsolatedFinanceData(async () => {
      const now = new Date("2026-04-15T09:30:00.000Z");
      createFinanceAccount(
        {
          name: "Cash Reserve",
          type: "checking",
          currency: "USD",
          balance: 4200,
        },
        now,
      );

      installRateTransport({});
      const dashboard = await getFinanceReportingDashboard("USD", now);

      expect(dashboard.history).toHaveLength(1);
      expect(dashboard.history[0]).toMatchObject({
        accountId: null,
        date: "2026-04-15",
        equity: 4200,
        cash: null,
        currency: "USD",
        source: "portfolio",
      });
    });
  });
});
