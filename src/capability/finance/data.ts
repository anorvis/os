import { randomUUID } from "node:crypto";
import { decodeUnknownResult } from "../../core/effect/schema";
import { getDatabase } from "../../core/db/database";
import { readSnapshot } from "../../core/snapshots/snapshots";
import { CsvImportInputSchema } from "./schema";

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
  const decoded = decodeUnknownResult(CsvImportInputSchema, value);
  if (!decoded.ok) return null;
  if (decoded.value.transactions.some((transaction) => Number.isNaN(new Date(transaction.date).getTime()))) return null;
  return {
    source: decoded.value.source,
    accountName: decoded.value.accountName.trim(),
    balance: typeof decoded.value.balance === "number" && Number.isFinite(decoded.value.balance) ? decoded.value.balance : null,
    transactions: decoded.value.transactions.map((transaction) => ({
      externalId: typeof transaction.externalId === "string" ? transaction.externalId : null,
      fingerprint: transaction.fingerprint,
      date: transaction.date,
      description: transaction.description,
      amount: transaction.amount,
      category: transaction.category,
      currency: transaction.currency,
    })),
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

