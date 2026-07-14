"use node";

import { ConvexError, v } from "convex/values";
import { api } from "./_generated/api";
import { action } from "./_generated/server";
import {
  addDecimal,
  formatDecimal,
  parseDecimal,
  zeroDecimal,
  type Decimal,
} from "./lib/decimal";

const FIAT_URL = "https://api.frankfurter.app/latest";
const BITCOIN_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

type Row = Record<string, unknown>;
type Rates = Map<string, number>;

export const dashboard = action({
  args: { currency: v.string() },
  handler: async (ctx, args): Promise<unknown> => {
    const currency = args.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Currency must be a three-letter code",
      });
    }
    const dashboard = (await ctx.runQuery(api.finance.dashboard, {})) as Row;
    const sourceCurrencies = currencies(dashboard);
    const rates = await loadRates(sourceCurrencies, currency);
    const convertRows = (
      name: string,
      fields: string[],
      options: { keepQuantity?: boolean } = {},
    ): Row[] =>
      rows(dashboard[name]).map((row) => {
        const source = text(row.currency) ?? currency;
        const next: Row = { ...row, currency };
        for (const field of fields) {
          if (options.keepQuantity && field === "quantity") continue;
          next[field] = convertValue(row[field], source, currency, rates);
        }
        return next;
      });
    const accounts = convertRows("accounts", ["balance"]);
    const balances = convertRows("balances", ["cash", "buyingPower"]);
    const transactions = convertRows("transactions", ["amount"]);
    const positions = convertRows("positions", ["marketValue", "averageCost"]);
    const activities = convertRows("activities", ["amount", "price"]);
    const valueHistory = aggregateHistory(
      rows(dashboard.valueHistory),
      rows(dashboard.accounts),
      currency,
      rates,
    );
    const total = accounts.reduce<Decimal>((sum, account) => {
      if (account.status === "hidden" || account.balance == null) return sum;
      return addDecimal(sum, parseDecimal(String(account.balance)));
    }, zeroDecimal());
    const converted = [...sourceCurrencies].some(
      (source) => source !== currency,
    );
    return {
      ...dashboard,
      accounts,
      balances,
      transactions,
      positions,
      activities,
      valueHistory,
      totalsByCurrency: [{ currency, balance: formatDecimal(total) }],
      conversion: {
        currency,
        asOf: converted ? new Date().toISOString() : null,
        providers: converted
          ? ["frankfurter", ...(sourceCurrencies.has("BTC") ? ["coingecko"] : [])]
          : [],
        stale: false,
      },
    };
  },
});

function currencies(dashboard: Row): Set<string> {
  const result = new Set<string>();
  for (const name of [
    "accounts",
    "balances",
    "transactions",
    "positions",
    "activities",
    "valueHistory",
  ]) {
    for (const row of rows(dashboard[name])) {
      const currency = text(row.currency)?.toUpperCase();
      if (currency) result.add(currency);
    }
  }
  return result;
}

async function loadRates(sources: Set<string>, target: string): Promise<Rates> {
  const currencies = new Set([...sources, target]);
  const fiat = [...currencies].filter((currency) => currency !== "BTC");
  const rates: Rates = new Map([["USD", 1]]);
  if (fiat.some((currency) => currency !== "USD")) {
    const response = await fetch(
      `${FIAT_URL}?from=USD&to=${encodeURIComponent(fiat.filter((currency) => currency !== "USD").join(","))}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) throw rateError(`Fiat exchange rate request failed: ${response.status}`);
    const payload = (await response.json()) as { rates?: unknown };
    if (!payload.rates || typeof payload.rates !== "object") {
      throw rateError("Fiat exchange rate response is invalid");
    }
    for (const [currency, value] of Object.entries(payload.rates)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        rates.set(currency.toUpperCase(), value);
      }
    }
  }
  if (currencies.has("BTC")) {
    const response = await fetch(BITCOIN_URL, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw rateError(`Bitcoin exchange rate request failed: ${response.status}`);
    const payload = (await response.json()) as { bitcoin?: { usd?: unknown } };
    const usd = payload.bitcoin?.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
      throw rateError("Bitcoin exchange rate response is invalid");
    }
    rates.set("BTC", 1 / usd);
  }
  for (const currency of currencies) {
    if (!rates.has(currency)) throw rateError(`Exchange rate unavailable for ${currency}`);
  }
  return rates;
}

function convertValue(
  value: unknown,
  source: string,
  target: string,
  rates: Rates,
): unknown {
  if (value === undefined || value === null) return value;
  const amount = number(value);
  if (amount === null) return value;
  if (source === target) return typeof value === "string" ? value : String(amount);
  const sourcePerUsd = rates.get(source);
  const targetPerUsd = rates.get(target);
  if (!sourcePerUsd || !targetPerUsd) throw rateError(`Exchange rate unavailable for ${source}`);
  return roundedDecimal((amount / sourcePerUsd) * targetPerUsd);
}

function aggregateHistory(
  values: Row[],
  accounts: Row[],
  currency: string,
  rates: Rates,
): Row[] {
  const accountTypes = new Map(
    accounts
      .filter((account) => account.status !== "hidden")
      .map((account) => [String(account._id), text(account.type) ?? "checking"]),
  );
  const accountValues = values.filter(
    (row) => row.accountId != null && accountTypes.has(String(row.accountId)),
  );
  if (accountValues.length === 0) {
    return values.map((row) => ({
      ...row,
      currency,
      equity: convertValue(row.equity, text(row.currency) ?? currency, currency, rates),
      cash: convertValue(row.cash, text(row.currency) ?? currency, currency, rates),
    }));
  }
  const rowsByDate = new Map<string, Row[]>();
  for (const row of accountValues) {
    const date = text(row.date);
    if (!date) continue;
    const current = rowsByDate.get(date) ?? [];
    current.push(row);
    rowsByDate.set(date, current);
  }
  const latest = new Map<string, Row>();
  const result: Row[] = [];
  for (const date of [...rowsByDate.keys()].sort()) {
    for (const row of rowsByDate.get(date) ?? []) {
      latest.set(String(row.accountId), row);
    }
    let equity = zeroDecimal();
    let cash = zeroDecimal();
    let hasCash = false;
    for (const [accountId, row] of latest) {
      const liability = ["credit", "loan"].includes(accountTypes.get(accountId) ?? "");
      equity = addDecimal(
        equity,
        signedDecimal(
          convertValue(row.equity, text(row.currency) ?? currency, currency, rates),
          liability,
        ),
      );
      if (row.cash != null) {
        cash = addDecimal(
          cash,
          signedDecimal(
            convertValue(row.cash, text(row.currency) ?? currency, currency, rates),
            liability,
          ),
        );
        hasCash = true;
      }
    }
    result.push({
      date,
      equity: formatDecimal(equity),
      cash: hasCash ? formatDecimal(cash) : undefined,
      currency,
      source: "portfolio",
    });
  }
  return result;
}

function signedDecimal(value: unknown, liability: boolean): Decimal {
  const parsed = parseDecimal(String(value ?? "0"));
  return liability
    ? { ...parsed, units: -1n * (parsed.units < 0n ? -parsed.units : parsed.units) }
    : parsed;
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => typeof item === "object" && item !== null)
    : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function roundedDecimal(value: number): string {
  return value.toFixed(8).replace(/\.?0+$/, "");
}

function rateError(message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "RATE_UNAVAILABLE", message });
}
