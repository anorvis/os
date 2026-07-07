import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/database";
import { readSnapshot } from "../shared/snapshots";

export type FinancePortfolio = {
  equity: number;
  cash: number;
  positions: Array<{
    symbol: string;
    qty: number;
    marketValue: number;
    unrealizedPl?: number;
    unrealizedPlPc?: number;
  }>;
};

export type FinancePortfolioResponse = {
  portfolio: FinancePortfolio | null;
  history: Array<{ date: string; equity: number }>;
};

export type CsvImportInput = {
  source: "chase_cc" | "chase_checking" | "td_canada" | "wealthsimple" | "manual";
  accountName: string;
  balance?: number | null;
  transactions: Array<{
    externalId?: string | null;
    fingerprint: string;
    date: string;
    description: string;
    amount: number;
    category: string;
    currency: "CAD" | "USD" | "BTC";
  }>;
};

type AccountRow = {
  id: string;
  balance: number | null;
};

type PositionRow = {
  symbol: string;
  quantity: number;
  market_value: number | null;
};

type HistoryRow = {
  date: string;
  equity: number;
};

export function getFinancePortfolio(): FinancePortfolioResponse {
  return readSnapshot("finance_dashboard_snapshot", "finance", buildFinancePortfolio);
}

function buildFinancePortfolio(): FinancePortfolioResponse {
  const accounts = getDatabase().query<AccountRow, []>("SELECT id, balance FROM finance_accounts ORDER BY updated_at DESC").all();
  const positions = getDatabase().query<PositionRow, []>("SELECT symbol, quantity, market_value FROM finance_positions ORDER BY symbol ASC").all();
  const cash = accounts.reduce((total, account) => total + (account.balance ?? 0), 0);
  const portfolioPositions = positions.map((position) => ({
    symbol: position.symbol,
    qty: position.quantity,
    marketValue: position.market_value ?? 0,
  }));
  const positionValue = portfolioPositions.reduce((total, position) => total + position.marketValue, 0);
  const history = getDatabase().query<HistoryRow, []>("SELECT date, equity FROM finance_portfolio_history ORDER BY date ASC").all();
  const portfolio = accounts.length || portfolioPositions.length ? { equity: cash + positionValue, cash, positions: portfolioPositions } : null;
  return { portfolio, history };
}

export function importFinanceCsv(input: CsvImportInput, now = new Date()): { imported: number; skippedDuplicates: number; accountId: string } {
  const timestamp = now.toISOString();
  const accountId = upsertAccount(input, timestamp);
  let imported = 0;
  let skippedDuplicates = 0;
  const insertTransaction = getDatabase().query(`
    INSERT OR IGNORE INTO finance_transactions (id, account_id, source, source_id, fingerprint, description, amount, currency, posted_at, category_id, status, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'posted', ?11, ?11)
  `);
  for (const transaction of input.transactions) {
    const result = insertTransaction.run(randomUUID(), accountId, `csv:${input.source}`, transaction.externalId ?? null, transaction.fingerprint, transaction.description, transaction.amount, transaction.currency, new Date(transaction.date).toISOString(), transaction.category, timestamp);
    if (result.changes > 0) imported += 1;
    else skippedDuplicates += 1;
  }
  return { imported, skippedDuplicates, accountId };
}

export function parseCsvImport(value: unknown): CsvImportInput | null {
  if (!isRecord(value)) return null;
  const source = value.source;
  const accountName = value.accountName;
  const transactions = value.transactions;
  if (!isFinanceSource(source) || typeof accountName !== "string" || !Array.isArray(transactions)) return null;
  const parsedTransactions = transactions.map(parseTransaction).filter((transaction): transaction is CsvImportInput["transactions"][number] => transaction !== null);
  if (parsedTransactions.length !== transactions.length) return null;
  return {
    source,
    accountName: accountName.trim(),
    balance: typeof value.balance === "number" && Number.isFinite(value.balance) ? value.balance : null,
    transactions: parsedTransactions,
  };
}

function upsertAccount(input: CsvImportInput, timestamp: string): string {
  const existing = getDatabase().query<{ id: string }, [string, string]>("SELECT id FROM finance_accounts WHERE source = ?1 AND name = ?2").get(`csv:${input.source}`, input.accountName);
  const id = existing?.id ?? randomUUID();
  getDatabase().query(`
    INSERT INTO finance_accounts (id, source, name, type, currency, balance, created_at, updated_at)
    VALUES (?1, ?2, ?3, 'checking', 'USD', ?4, ?5, ?5)
    ON CONFLICT(id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at
  `).run(id, `csv:${input.source}`, input.accountName, input.balance ?? null, timestamp);
  return id;
}

function parseTransaction(value: unknown): CsvImportInput["transactions"][number] | null {
  if (!isRecord(value)) return null;
  const fingerprint = value.fingerprint;
  const date = value.date;
  const description = value.description;
  const amount = value.amount;
  const category = value.category;
  const currency = value.currency;
  if (typeof fingerprint !== "string" || typeof date !== "string" || typeof description !== "string" || typeof amount !== "number" || typeof category !== "string" || !isCurrency(currency)) return null;
  if (Number.isNaN(new Date(date).getTime())) return null;
  return {
    externalId: typeof value.externalId === "string" ? value.externalId : null,
    fingerprint,
    date,
    description,
    amount,
    category,
    currency,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFinanceSource(value: unknown): value is CsvImportInput["source"] {
  return value === "chase_cc" || value === "chase_checking" || value === "td_canada" || value === "wealthsimple" || value === "manual";
}

function isCurrency(value: unknown): value is "CAD" | "USD" | "BTC" {
  return value === "CAD" || value === "USD" || value === "BTC";
}
