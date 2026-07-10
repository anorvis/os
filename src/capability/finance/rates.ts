import {
  getFinanceDashboard,
  type FinanceAccountRecord,
  type FinanceActivityRecord,
  type FinanceBalanceRecord,
  type FinanceDashboard,
  type FinanceHistoryRecord,
  type FinancePositionRecord,
  type FinanceTransactionRecord,
} from "./data";

const FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rates";
const KRAKEN_URL = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD";
const FIAT_FRESH_MS = 15 * 60 * 1000;
const FIAT_STALE_MS = 24 * 60 * 60 * 1000;
const BITCOIN_FRESH_MS = 5 * 60 * 1000;
const BITCOIN_STALE_MS = 60 * 60 * 1000;

type RateFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
type CachedRate = {
  rate: number;
  asOf: string;
  fetchedAt: number;
};

type ConversionContext = {
  usdTo: Map<string, CachedRate>;
  bitcoinUsd: CachedRate | null;
  providers: string[];
  stale: boolean;
};

export type FinanceConversion = {
  currency: string;
  asOf: string | null;
  providers: string[];
  stale: boolean;
};

export type FinanceReportingDashboard = FinanceDashboard & {
  conversion: FinanceConversion;
};

export class FinanceRateError extends Error {
  readonly code: "invalid_currency" | "rate_unavailable";

  constructor(
    message: string,
    code: "invalid_currency" | "rate_unavailable" = "rate_unavailable",
  ) {
    super(message);
    this.name = "FinanceRateError";
    this.code = code;
  }
}

const fiatRates = new Map<string, CachedRate>();
let bitcoinUsd: CachedRate | null = null;
let transport: RateFetch = (input, init) => fetch(input, init);

export function setFinanceRateFetch(next: RateFetch | null): void {
  transport = next ?? ((input, init) => fetch(input, init));
  fiatRates.clear();
  bitcoinUsd = null;
}

export function parseReportingCurrency(value: string | null): string | null {
  if (!value) return null;
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

export async function getFinanceReportingDashboard(
  currency: string,
  now = new Date(),
): Promise<FinanceReportingDashboard> {
  const target = parseReportingCurrency(currency);
  if (!target) {
    throw new FinanceRateError(
      "currency must be a three-letter currency code",
      "invalid_currency",
    );
  }

  const dashboard = getFinanceDashboard();
  const sourceCurrencies = collectCurrencies(dashboard);
  const requiresConversion = [...sourceCurrencies].some(
    (source) => source !== target,
  );
  if (!requiresConversion) {
    const history = aggregateHistory(
      dashboard.history,
      dashboard.accounts,
      target,
      null,
    );
    return {
      ...dashboard,
      history,
      conversion: {
        currency: target,
        asOf: null,
        providers: [],
        stale: false,
      },
    };
  }

  const context = await loadRates(new Set([...sourceCurrencies, target]), now);
  const accounts = dashboard.accounts.map((record) =>
    convertAccount(record, target, context),
  );
  const balances = dashboard.balances.map((record) =>
    convertBalance(record, target, context),
  );
  const transactions = dashboard.transactions.map((record) =>
    convertTransaction(record, target, context),
  );
  const positions = dashboard.positions.map((record) =>
    convertPosition(record, target, context),
  );
  const activities = dashboard.activities.map((record) =>
    convertActivity(record, target, context),
  );
  const history = aggregateHistory(
    dashboard.history,
    dashboard.accounts,
    target,
    context,
  );
  const asOf = ratesAsOf(context);

  return {
    ...dashboard,
    accounts,
    balances,
    transactions,
    positions,
    activities,
    history,
    byCurrency: [
      {
        currency: target,
        accounts,
        balances,
        transactions,
        positions,
        activities,
      },
    ],
    conversion: {
      currency: target,
      asOf,
      providers: context.providers,
      stale: context.stale,
    },
  };
}

function collectCurrencies(dashboard: FinanceDashboard): Set<string> {
  const currencies = new Set<string>();
  for (const record of dashboard.accounts) currencies.add(record.currency);
  for (const record of dashboard.balances) currencies.add(record.currency);
  for (const record of dashboard.transactions) currencies.add(record.currency);
  for (const record of dashboard.positions) currencies.add(record.currency);
  for (const record of dashboard.activities) currencies.add(record.currency);
  for (const record of dashboard.history) currencies.add(record.currency);
  return new Set(
    [...currencies].map((currency) => currency.trim().toUpperCase()),
  );
}

function aggregateHistory(
  records: FinanceHistoryRecord[],
  accounts: FinanceAccountRecord[],
  target: string,
  context: ConversionContext | null,
): FinanceHistoryRecord[] {
  const convertValue = (value: number, source: string) =>
    context && source !== target
      ? convert(value, source, target, context)
      : value;
  const accountTypes = new Map(
    accounts
      .filter((account) => account.status !== "hidden")
      .map((account) => [account.id, account.type]),
  );
  const accountRecords = records.filter(
    (record) => record.accountId !== null && accountTypes.has(record.accountId),
  );
  if (accountRecords.length === 0) {
    return records.map((record) => ({
      ...record,
      currency: target,
      equity: convertValue(record.equity, record.currency),
      cash:
        record.cash === null
          ? null
          : convertValue(record.cash, record.currency),
    }));
  }

  const rowsByDate = new Map<string, FinanceHistoryRecord[]>();
  for (const record of accountRecords) {
    const rows = rowsByDate.get(record.date) ?? [];
    rows.push(record);
    rowsByDate.set(record.date, rows);
  }
  const latestByAccount = new Map<string, FinanceHistoryRecord>();
  const history: FinanceHistoryRecord[] = [];
  for (const date of [...rowsByDate.keys()].sort()) {
    for (const record of rowsByDate.get(date) ?? []) {
      if (record.accountId) latestByAccount.set(record.accountId, record);
    }
    let equity = 0;
    let cash = 0;
    let hasCash = false;
    for (const record of latestByAccount.values()) {
      const type = record.accountId ? accountTypes.get(record.accountId) : null;
      const isLiability = type === "credit" || type === "loan";
      const convertedEquity = convertValue(record.equity, record.currency);
      equity += isLiability ? -Math.abs(convertedEquity) : convertedEquity;
      if (record.cash !== null) {
        const convertedCash = convertValue(record.cash, record.currency);
        cash += isLiability ? -Math.abs(convertedCash) : convertedCash;
        hasCash = true;
      }
    }
    history.push({
      accountId: null,
      date,
      equity,
      cash: hasCash ? cash : null,
      currency: target,
      source: "portfolio",
    });
  }
  return history;
}

async function loadRates(
  currencies: Set<string>,
  now: Date,
): Promise<ConversionContext> {
  const fiatCurrencies = [...currencies].filter(
    (currency) => currency !== "BTC",
  );
  const fiat = await loadFiatRates(fiatCurrencies, now);
  const needsBitcoin = currencies.has("BTC");
  const bitcoin = needsBitcoin ? await loadBitcoinUsd(now) : null;
  return {
    usdTo: fiat.rates,
    bitcoinUsd: bitcoin?.rate ?? null,
    providers: [
      ...(fiat.usedProvider ? ["Frankfurter / ECB"] : []),
      ...(bitcoin?.usedProvider ? ["Kraken"] : []),
    ],
    stale: fiat.stale || Boolean(bitcoin?.stale),
  };
}

async function loadFiatRates(
  currencies: string[],
  now: Date,
): Promise<{
  rates: Map<string, CachedRate>;
  stale: boolean;
  usedProvider: boolean;
}> {
  const nowMs = now.getTime();
  const unique = [...new Set(currencies)];
  const quotes = unique.filter((currency) => currency !== "USD");
  const staleQuotes = quotes.filter((currency) => {
    const cached = fiatRates.get(currency);
    return !cached || nowMs - cached.fetchedAt > FIAT_FRESH_MS;
  });
  let stale = false;

  if (staleQuotes.length > 0) {
    const url = new URL(FRANKFURTER_URL);
    url.searchParams.set("base", "USD");
    url.searchParams.set("quotes", staleQuotes.join(","));
    url.searchParams.set("providers", "ECB");
    try {
      const response = await transport(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        throw new Error(`Frankfurter returned ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (!Array.isArray(payload))
        throw new Error("invalid Frankfurter response");
      for (const row of payload) {
        if (!isRecord(row)) continue;
        const quote = stringValue(row.quote)?.toUpperCase();
        const rate = positiveNumber(row.rate);
        const asOf = stringValue(row.date);
        if (!quote || rate === null || !asOf) continue;
        fiatRates.set(quote, { rate, asOf, fetchedAt: nowMs });
      }
    } catch (error) {
      const unavailable = staleQuotes.filter((currency) => {
        const cached = fiatRates.get(currency);
        return !cached || nowMs - cached.fetchedAt > FIAT_STALE_MS;
      });
      if (unavailable.length > 0) {
        throw new FinanceRateError(
          `exchange rates unavailable for ${unavailable.join(", ")}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      stale = true;
    }
  }

  const rates = new Map<string, CachedRate>();
  rates.set("USD", { rate: 1, asOf: now.toISOString(), fetchedAt: nowMs });
  for (const currency of quotes) {
    const cached = fiatRates.get(currency);
    if (!cached) {
      throw new FinanceRateError(`exchange rate unavailable for ${currency}`);
    }
    rates.set(currency, cached);
    if (nowMs - cached.fetchedAt > FIAT_FRESH_MS) stale = true;
  }
  return { rates, stale, usedProvider: quotes.length > 0 };
}

async function loadBitcoinUsd(
  now: Date,
): Promise<{ rate: CachedRate; stale: boolean; usedProvider: boolean }> {
  const nowMs = now.getTime();
  if (bitcoinUsd && nowMs - bitcoinUsd.fetchedAt <= BITCOIN_FRESH_MS) {
    return { rate: bitcoinUsd, stale: false, usedProvider: true };
  }
  try {
    const response = await transport(KRAKEN_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Kraken returned ${response.status}`);
    const payload: unknown = await response.json();
    const root = isRecord(payload) ? payload : null;
    const errors = Array.isArray(root?.error) ? root.error : [];
    if (errors.length > 0) throw new Error(errors.join(", "));
    const result = isRecord(root?.result) ? root.result : null;
    const ticker = result ? Object.values(result).find(isRecord) : null;
    const close: unknown = Array.isArray(ticker?.c) ? ticker.c[0] : null;
    const rate = positiveNumber(close);
    if (rate === null) throw new Error("invalid Kraken response");
    bitcoinUsd = {
      rate,
      asOf: now.toISOString(),
      fetchedAt: nowMs,
    };
    return { rate: bitcoinUsd, stale: false, usedProvider: true };
  } catch (error) {
    if (!bitcoinUsd || nowMs - bitcoinUsd.fetchedAt > BITCOIN_STALE_MS) {
      throw new FinanceRateError(
        `Bitcoin exchange rate unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    return { rate: bitcoinUsd, stale: true, usedProvider: true };
  }
}

function convertAccount(
  record: FinanceAccountRecord,
  target: string,
  context: ConversionContext,
): FinanceAccountRecord {
  return {
    ...record,
    balance:
      record.balance === null
        ? null
        : convert(record.balance, record.currency, target, context),
    currency: target,
  };
}

function convertBalance(
  record: FinanceBalanceRecord,
  target: string,
  context: ConversionContext,
): FinanceBalanceRecord {
  return {
    ...record,
    cash:
      record.cash === null
        ? null
        : convert(record.cash, record.currency, target, context),
    buyingPower:
      record.buyingPower === null
        ? null
        : convert(record.buyingPower, record.currency, target, context),
    currency: target,
  };
}

function convertTransaction(
  record: FinanceTransactionRecord,
  target: string,
  context: ConversionContext,
): FinanceTransactionRecord {
  return {
    ...record,
    amount: convert(record.amount, record.currency, target, context),
    currency: target,
  };
}

function convertPosition(
  record: FinancePositionRecord,
  target: string,
  context: ConversionContext,
): FinancePositionRecord {
  return {
    ...record,
    marketValue:
      record.marketValue === null
        ? null
        : convert(record.marketValue, record.currency, target, context),
    averageCost:
      record.averageCost === null
        ? null
        : convert(record.averageCost, record.currency, target, context),
    currency: target,
  };
}

function convertActivity(
  record: FinanceActivityRecord,
  target: string,
  context: ConversionContext,
): FinanceActivityRecord {
  return {
    ...record,
    amount:
      record.amount === null
        ? null
        : convert(record.amount, record.currency, target, context),
    price:
      record.price === null
        ? null
        : convert(record.price, record.currency, target, context),
    currency: target,
  };
}

function convert(
  amount: number,
  source: string,
  target: string,
  context: ConversionContext,
): number {
  const from = source.trim().toUpperCase();
  if (from === target) return amount;
  const usdAmount =
    from === "BTC"
      ? amount * requireBitcoinUsd(context)
      : amount / requireFiatRate(from, context);
  return target === "BTC"
    ? usdAmount / requireBitcoinUsd(context)
    : usdAmount * requireFiatRate(target, context);
}

function requireFiatRate(currency: string, context: ConversionContext): number {
  const rate = context.usdTo.get(currency)?.rate;
  if (!rate) {
    throw new FinanceRateError(`exchange rate unavailable for ${currency}`);
  }
  return rate;
}

function requireBitcoinUsd(context: ConversionContext): number {
  const rate = context.bitcoinUsd?.rate;
  if (!rate) throw new FinanceRateError("Bitcoin exchange rate unavailable");
  return rate;
}

function ratesAsOf(context: ConversionContext): string | null {
  const dates = [
    ...[...context.usdTo.entries()]
      .filter(([currency]) => currency !== "USD")
      .map(([, entry]) => entry.asOf),
    ...(context.bitcoinUsd ? [context.bitcoinUsd.asOf] : []),
  ];
  return dates.sort().at(0) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
