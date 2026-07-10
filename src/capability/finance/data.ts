import { createHash, randomUUID } from "node:crypto";
import { decodeUnknownResult } from "../../core/effect/schema";
import { getDatabase } from "../../core/db/database";
import { readSnapshot } from "../../core/snapshots/snapshots";
import {
  CsvImportInputSchema,
  type CanonicalAccountInput,
  type CanonicalAccountHistoryInput,
  type CanonicalAccountReturnRateInput,
  type CanonicalActivityInput,
  type CanonicalBalanceInput,
  type CanonicalCategoryInput,
  type CanonicalImportInput,
  type CanonicalPositionInput,
  type CanonicalTransactionInput,
  type FinanceAccountType,
  type UpdateFinanceAccountInput,
} from "./schema";

// ---------------------------------------------------------------------------
// Legacy portfolio read (kept for /v1/finance/portfolio compatibility).
// ---------------------------------------------------------------------------

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
  source:
    "chase_cc" | "chase_checking" | "td_canada" | "wealthsimple" | "manual";
  accountId: string;
  balance?: number | null;
  transactions: Array<{
    externalId?: string | null;
    fingerprint: string;
    date: string;
    description: string;
    amount: number;
    category: string;
    currency: string;
  }>;
};

export type CreateFinanceAccountInput = {
  name: string;
  type: FinanceAccountType;
  currency: string;
  balance?: number | null;
};

export type FinanceAccountUpdateInput = UpdateFinanceAccountInput;

// Single currency the legacy portfolio view aggregates. Everything else is
// exposed per-currency through getFinanceDashboard().
const PORTFOLIO_BASE_CURRENCY = "USD";

type AccountRow = { id: string; balance: number | null };
type PositionRow = {
  symbol: string;
  quantity: number;
  market_value: number | null;
};
type HistoryRow = { date: string; equity: number };

export function getFinancePortfolio(): FinancePortfolioResponse {
  return readSnapshot(
    "finance_dashboard_snapshot",
    "finance",
    buildFinancePortfolio,
  );
}

function buildFinancePortfolio(): FinancePortfolioResponse {
  const db = getDatabase();
  // Portfolio is a single-currency (USD) brokerage view. Scoping to one
  // currency removes the previous cross-currency summation of mixed balances.
  const accounts = db
    .query<AccountRow, [string]>(
      "SELECT id, balance FROM finance_accounts WHERE currency = ?1 ORDER BY updated_at DESC",
    )
    .all(PORTFOLIO_BASE_CURRENCY);
  const positions = db
    .query<PositionRow, [string]>(
      "SELECT symbol, quantity, market_value FROM finance_positions WHERE currency = ?1 ORDER BY symbol ASC",
    )
    .all(PORTFOLIO_BASE_CURRENCY);
  const cash = accounts.reduce(
    (total, account) => total + (account.balance ?? 0),
    0,
  );
  const portfolioPositions = positions.map((position) => ({
    symbol: position.symbol,
    qty: position.quantity,
    marketValue: position.market_value ?? 0,
  }));
  const positionValue = portfolioPositions.reduce(
    (total, position) => total + position.marketValue,
    0,
  );
  const history = db
    .query<HistoryRow, []>(
      "SELECT date, equity FROM finance_portfolio_history ORDER BY date ASC",
    )
    .all();
  const portfolio =
    accounts.length || portfolioPositions.length
      ? { equity: cash + positionValue, cash, positions: portfolioPositions }
      : null;
  return { portfolio, history };
}

// ---------------------------------------------------------------------------
// Canonical dashboard output records (raw, grouped by original currency).
// ---------------------------------------------------------------------------

export type FinanceAccountRecord = {
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
  importId: string | null;
  observedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FinanceBalanceRecord = {
  id: string;
  accountId: string;
  currency: string;
  cash: number | null;
  buyingPower: number | null;
  observedAt: string;
  source: string;
  sourceVariant: string | null;
  importId: string | null;
  updatedAt: string;
};

export type FinanceTransactionRecord = {
  id: string;
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

export type FinanceCategoryRecord = {
  id: string;
  name: string;
  group: string;
  excludeFromSpending: boolean;
  color: string | null;
};

export type FinancePositionRecord = {
  id: string;
  accountId: string | null;
  source: string;
  sourceVariant: string | null;
  symbol: string;
  name: string | null;
  quantity: number;
  marketValue: number | null;
  averageCost: number | null;
  currency: string;
  observedAt: string | null;
  updatedAt: string;
};

export type FinanceActivityRecord = {
  id: string;
  accountId: string | null;
  source: string;
  sourceVariant: string | null;
  type: string;
  description: string | null;
  amount: number | null;
  currency: string;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  occurredAt: string;
  settledAt: string | null;
  status: string;
};

export type FinanceHistoryRecord = {
  accountId: string | null;
  date: string;
  equity: number;
  cash: number | null;
  currency: string;
  source: string;
};

export type FinanceAccountReturnRateRecord = {
  accountId: string;
  source: string;
  sourceVariant: string | null;
  timeframe: string;
  returnPercent: number;
  asOf: string | null;
  observedAt: string;
  updatedAt: string;
};

export type FinanceImportRecord = {
  id: string;
  source: string;
  sourceVariant: string | null;
  accountId: string | null;
  status: string;
  importedCount: number;
  skippedCount: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FinanceSourceFreshness = {
  source: string;
  sourceVariant: string | null;
  accountCount: number;
  transactionCount: number;
  lastObservedAt: string | null;
  lastImportedAt: string | null;
};

export type FinanceCurrencyGroup = {
  currency: string;
  accounts: FinanceAccountRecord[];
  balances: FinanceBalanceRecord[];
  transactions: FinanceTransactionRecord[];
  positions: FinancePositionRecord[];
  activities: FinanceActivityRecord[];
};

export type FinanceDashboard = {
  accounts: FinanceAccountRecord[];
  balances: FinanceBalanceRecord[];
  transactions: FinanceTransactionRecord[];
  categories: FinanceCategoryRecord[];
  positions: FinancePositionRecord[];
  activities: FinanceActivityRecord[];
  history: FinanceHistoryRecord[];
  returnRates: FinanceAccountReturnRateRecord[];
  imports: FinanceImportRecord[];
  byCurrency: FinanceCurrencyGroup[];
  sources: FinanceSourceFreshness[];
};

// ---------------------------------------------------------------------------
// Canonical helpers (provider-neutral).
// ---------------------------------------------------------------------------

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeMask(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/[^A-Za-z0-9]/g, "");
  return normalized ? normalized.slice(-4) : null;
}

export function slugifyName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeDescription(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

// Normalize a free-text category name into a canonical spending group.
function transactionSignature(
  ledgerAccountId: string,
  postedAt: string,
  currency: string,
  amount: number,
  description: string,
): string {
  return createHash("sha256")
    .update(
      [
        ledgerAccountId,
        normalizeDate(postedAt).slice(0, 10),
        normalizeCurrency(currency),
        String(Math.round(amount * 100)),
        normalizeDescription(description),
      ].join("\n"),
    )
    .digest("hex");
}

function dedupeKeyFor(signature: string, occurrence: number): string {
  return `txv1:${signature}:${occurrence}`;
}

export function resolveCanonicalAccountId(
  accountId: string | null | undefined,
): string | null {
  if (!accountId) return null;
  const row = getDatabase()
    .query<{ canonical_account_id: string }, [string]>(
      "SELECT canonical_account_id FROM finance_account_links WHERE account_id = ?1",
    )
    .get(accountId);
  return row?.canonical_account_id ?? accountId;
}

function categoryGroup(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === "income") return "income";
  if (
    normalized === "transfer" ||
    normalized === "transfers" ||
    normalized === "internal transfer"
  )
    return "transfers";
  if (
    normalized === "loan payment" ||
    normalized === "debt" ||
    normalized === "debt payments"
  )
    return "debt";
  if (
    normalized === "investing" ||
    normalized === "investment" ||
    normalized === "investments"
  )
    return "investing";
  if (
    normalized === "" ||
    normalized === "uncategorized" ||
    normalized === "other"
  )
    return "other";
  return "spending";
}

function categorySlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug || "uncategorized";
}

function readFinanceAccountRecord(id: string): FinanceAccountRecord | null {
  return (
    getDatabase()
      .query<FinanceAccountRecord, [string]>(
        `
        SELECT id, source, source_id AS sourceId, source_variant AS sourceVariant, name, type, currency, balance,
               institution, mask, status, import_id AS importId, observed_at AS observedAt, created_at AS createdAt, updated_at AS updatedAt
        FROM finance_accounts
        WHERE id = ?1
      `,
      )
      .get(id) ?? null
  );
}

function readVisibleFinanceAccount(id: string): FinanceAccountRecord | null {
  return (
    getDatabase()
      .query<FinanceAccountRecord, [string]>(
        `
        SELECT id, source, source_id AS sourceId, source_variant AS sourceVariant, name, type, currency, balance,
               institution, mask, status, import_id AS importId, observed_at AS observedAt, created_at AS createdAt, updated_at AS updatedAt
        FROM finance_accounts
        WHERE id = ?1
          AND status = 'active'
          AND NOT EXISTS (SELECT 1 FROM finance_account_links l WHERE l.account_id = finance_accounts.id)
      `,
      )
      .get(id) ?? null
  );
}

export function createFinanceAccount(
  input: CreateFinanceAccountInput,
  now = new Date(),
): FinanceAccountRecord {
  const name = input.name.trim();
  const currency = normalizeCurrency(input.currency.trim());
  if (!name) throw new FinanceLinkError("account name is required", 400);
  if (!/^[A-Z]{3,5}$/.test(currency))
    throw new FinanceLinkError("account currency is invalid", 400);
  const balance =
    typeof input.balance === "number" && Number.isFinite(input.balance)
      ? input.balance
      : null;
  const timestamp = now.toISOString();
  const accountId = randomUUID();
  getDatabase().transaction(() => {
    getDatabase()
      .query(
        `
        INSERT INTO finance_accounts
          (id, source, source_id, source_variant, name, type, currency, balance, institution, mask, status, import_id, observed_at, created_at, updated_at)
        VALUES (?1, 'manual', NULL, NULL, ?2, ?3, ?4, ?5, NULL, NULL, 'active', NULL, ?6, ?6, ?6)
      `,
      )
      .run(accountId, name, input.type, currency, balance, timestamp);
    if (balance != null) {
      upsertFinanceAccountHistory(
        {
          accountId,
          source: "manual",
          sourceVariant: null,
          date: timestamp.slice(0, 10),
          equity: balance,
          cash: null,
          currency,
          importId: null,
          observedAt: timestamp,
        },
        now,
      );
    }
  })();
  const account = readVisibleFinanceAccount(accountId);
  if (!account) throw new FinanceLinkError("account not found", 404);
  return account;
}

export function updateFinanceAccount(
  accountId: string,
  patch: FinanceAccountUpdateInput,
  now = new Date(),
): FinanceAccountRecord {
  const account = readFinanceAccountRecord(accountId);
  if (!account) throw new FinanceLinkError("account not found", 404);
  if (
    getDatabase()
      .query<{ account_id: string }, [string]>(
        "SELECT account_id FROM finance_account_links WHERE account_id = ?1",
      )
      .get(accountId)
  ) {
    throw new FinanceLinkError(
      "linked duplicate account cannot be updated",
      409,
    );
  }

  const updates: string[] = [];
  const values: Array<string | number | null> = [accountId];
  const timestamp = now.toISOString();

  if (patch.status !== undefined) {
    values.push(patch.status);
    updates.push(`status = ?${values.length}`);
  }

  const editsManualFields = patch.name !== undefined || "balance" in patch;
  if (editsManualFields && account.source !== "manual") {
    throw new FinanceLinkError("only manual accounts can be edited", 409);
  }

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new FinanceLinkError("account name is required", 400);
    values.push(name);
    updates.push(`name = ?${values.length}`);
  }

  let historyBalance: number | null | undefined;
  if ("balance" in patch) {
    if (
      patch.balance !== null &&
      (typeof patch.balance !== "number" || !Number.isFinite(patch.balance))
    ) {
      throw new FinanceLinkError("account balance is invalid", 400);
    }
    historyBalance = patch.balance;
    values.push(patch.balance);
    updates.push(`balance = ?${values.length}`);
  }

  values.push(timestamp);
  updates.push(`updated_at = ?${values.length}`);

  getDatabase().transaction(() => {
    getDatabase()
      .query(`UPDATE finance_accounts SET ${updates.join(", ")} WHERE id = ?1`)
      .run(...values);
    if (typeof historyBalance === "number") {
      upsertFinanceAccountHistory(
        {
          accountId,
          source: "manual",
          sourceVariant: null,
          date: timestamp.slice(0, 10),
          equity: historyBalance,
          cash: null,
          currency: account.currency,
          importId: null,
          observedAt: timestamp,
        },
        now,
      );
    }
  })();

  const updated = readFinanceAccountRecord(accountId);
  if (!updated) throw new FinanceLinkError("account not found", 404);
  return updated;
}

export function deleteFinanceAccount(accountId: string): {
  ok: true;
  accountId: string;
  deletedTransactions: number;
} {
  const db = getDatabase();
  const account = readFinanceAccountRecord(accountId);
  if (!account) throw new FinanceLinkError("account not found", 404);
  if (account.source !== "manual")
    throw new FinanceLinkError("only manual accounts can be deleted", 409);
  let deletedTransactions = 0;
  db.transaction(() => {
    const transactions = db
      .query("DELETE FROM finance_transactions WHERE account_id = ?1")
      .run(accountId);
    deletedTransactions = transactions.changes;
    db.query("DELETE FROM finance_accounts WHERE id = ?1").run(accountId);
  })();
  return { ok: true, accountId, deletedTransactions };
}

// ---------------------------------------------------------------------------
// Canonical upsert / import primitives. A later SnapTrade module maps its own
// DTOs into these plain inputs — no SnapTrade types leak into canonical storage.
// ---------------------------------------------------------------------------

export function createImportBatch(
  input: CanonicalImportInput,
  now = new Date(),
): string {
  const timestamp = now.toISOString();
  const id = randomUUID();
  getDatabase()
    .query(
      `
      INSERT INTO finance_imports (id, source, source_variant, account_id, status, imported_count, skipped_count, error, started_at, finished_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, NULL, ?6, NULL, ?6, ?6)
    `,
    )
    .run(
      id,
      input.source,
      input.sourceVariant ?? null,
      input.accountId ?? null,
      input.status ?? "pending",
      timestamp,
    );
  return id;
}

export function finalizeImportBatch(
  importId: string,
  patch: {
    status?: string;
    imported?: number;
    skipped?: number;
    accountId?: string | null;
    error?: string | null;
  },
  now = new Date(),
): void {
  const timestamp = now.toISOString();
  getDatabase()
    .query(
      `
      UPDATE finance_imports SET
        status = COALESCE(?2, status),
        imported_count = COALESCE(?3, imported_count),
        skipped_count = COALESCE(?4, skipped_count),
        account_id = COALESCE(?5, account_id),
        error = ?6,
        finished_at = ?7,
        updated_at = ?7
      WHERE id = ?1
    `,
    )
    .run(
      importId,
      patch.status ?? null,
      patch.imported ?? null,
      patch.skipped ?? null,
      patch.accountId ?? null,
      patch.error ?? null,
      timestamp,
    );
}

// Identity: (source, source_id) when source_id is set (providers), otherwise
// (source, source_variant, name, currency) for CSV. Type/currency always come
// from input, and CSV accounts with the same name remain separate by currency.
export function upsertFinanceAccount(
  input: CanonicalAccountInput,
  now = new Date(),
): string {
  const db = getDatabase();
  const timestamp = now.toISOString();
  const currency = normalizeCurrency(input.currency);
  const existing = input.sourceId
    ? db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM finance_accounts WHERE source = ?1 AND source_id = ?2",
        )
        .get(input.source, input.sourceId)
    : db
        .query<{ id: string }, [string, string | null, string, string]>(
          "SELECT id FROM finance_accounts WHERE source = ?1 AND source_variant IS ?2 AND name = ?3 AND currency = ?4",
        )
        .get(input.source, input.sourceVariant ?? null, input.name, currency);
  const id = existing?.id ?? randomUUID();
  db.query(
    `
    INSERT INTO finance_accounts (id, source, source_id, source_variant, name, type, currency, balance, institution, mask, status, import_id, observed_at, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
    ON CONFLICT(id) DO UPDATE SET
      source_id = COALESCE(excluded.source_id, finance_accounts.source_id),
      source_variant = COALESCE(excluded.source_variant, finance_accounts.source_variant),
      name = excluded.name,
      type = excluded.type,
      currency = excluded.currency,
      balance = excluded.balance,
      institution = COALESCE(excluded.institution, finance_accounts.institution),
      mask = COALESCE(excluded.mask, finance_accounts.mask),
      status = excluded.status,
      import_id = COALESCE(excluded.import_id, finance_accounts.import_id),
      observed_at = COALESCE(excluded.observed_at, finance_accounts.observed_at),
      updated_at = excluded.updated_at
  `,
  ).run(
    id,
    input.source,
    input.sourceId ?? null,
    input.sourceVariant ?? null,
    input.name,
    input.type,
    currency,
    input.balance ?? null,
    input.institution ?? null,
    input.mask ?? null,
    input.status ?? "active",
    input.importId ?? null,
    input.observedAt ?? timestamp,
    timestamp,
  );
  return id;
}

// Identity: (account_id, currency). Multiple currencies on one account coexist
// as distinct rows, so brokerage accounts holding CAD and USD stay separate.
export function upsertFinanceBalance(
  input: CanonicalBalanceInput,
  now = new Date(),
): void {
  const timestamp = now.toISOString();
  getDatabase()
    .query(
      `
      INSERT INTO finance_balances (id, account_id, currency, cash, buying_power, observed_at, source, source_variant, import_id, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
      ON CONFLICT(account_id, currency) DO UPDATE SET
        cash = excluded.cash,
        buying_power = excluded.buying_power,
        observed_at = excluded.observed_at,
        source = excluded.source,
        source_variant = COALESCE(excluded.source_variant, finance_balances.source_variant),
        import_id = COALESCE(excluded.import_id, finance_balances.import_id),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      randomUUID(),
      input.accountId,
      normalizeCurrency(input.currency),
      input.cash ?? null,
      input.buyingPower ?? null,
      input.observedAt ?? timestamp,
      input.source,
      input.sourceVariant ?? null,
      input.importId ?? null,
      timestamp,
    );
}

// Normalizes a free-text category into a canonical group and returns its id.
export function upsertFinanceCategory(input: CanonicalCategoryInput): string {
  const name = input.name.trim() || "uncategorized";
  const id = categorySlug(name);
  const group = input.group ?? categoryGroup(name);
  const exclude =
    input.excludeFromSpending ??
    (group === "transfers" || group === "investing");
  getDatabase()
    .query(
      `
      INSERT INTO finance_categories (id, name, group_name, exclude_from_spending, color)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        group_name = excluded.group_name,
        exclude_from_spending = excluded.exclude_from_spending,
        color = COALESCE(excluded.color, finance_categories.color)
    `,
    )
    .run(id, name, group, exclude ? 1 : 0, input.color ?? null);
  return id;
}

export type TransactionDedupeContext = { claimed: Set<string> };
export type TransactionUpsertOutcome =
  "inserted" | "duplicate-source" | "duplicate-cross-source";

export function upsertFinanceTransaction(
  input: CanonicalTransactionInput,
  now = new Date(),
  dedupe?: TransactionDedupeContext,
): { inserted: boolean; id: string; outcome: TransactionUpsertOutcome } {
  const db = getDatabase();
  if (input.sourceId != null) {
    const existing = db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM finance_transactions WHERE source = ?1 AND source_id = ?2",
      )
      .get(input.source, input.sourceId);
    if (existing) {
      return { inserted: false, id: existing.id, outcome: "duplicate-source" };
    }
  }
  const sourceDuplicate = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM finance_transactions WHERE source = ?1 AND fingerprint = ?2",
    )
    .get(input.source, input.fingerprint);
  if (sourceDuplicate) {
    return {
      inserted: false,
      id: sourceDuplicate.id,
      outcome: "duplicate-source",
    };
  }

  const timestamp = now.toISOString();
  const categoryId =
    input.category && input.category.trim()
      ? upsertFinanceCategory({ name: input.category })
      : null;
  const ledgerAccountId = resolveCanonicalAccountId(input.accountId);
  const insert = (id: string, dedupeKey: string | null) =>
    db
      .query(
        `
        INSERT OR IGNORE INTO finance_transactions (id, account_id, source, source_id, source_variant, import_id, fingerprint, description, amount, currency, posted_at, category_id, status, notes, dedupe_key, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)
      `,
      )
      .run(
        id,
        ledgerAccountId,
        input.source,
        input.sourceId ?? null,
        input.sourceVariant ?? null,
        input.importId ?? null,
        input.fingerprint,
        input.description,
        input.amount,
        normalizeCurrency(input.currency),
        normalizeDate(input.postedAt),
        categoryId,
        input.status ?? "posted",
        input.notes ?? null,
        dedupeKey,
        timestamp,
      );

  if (ledgerAccountId === null) {
    const id = randomUUID();
    const result = insert(id, null);
    return {
      inserted: result.changes > 0,
      id,
      outcome: result.changes > 0 ? "inserted" : "duplicate-source",
    };
  }

  const signature = transactionSignature(
    ledgerAccountId,
    input.postedAt,
    input.currency,
    input.amount,
    input.description,
  );
  for (let occurrence = 1; occurrence <= 10000; occurrence += 1) {
    const key = dedupeKeyFor(signature, occurrence);
    if (dedupe?.claimed.has(key)) continue;
    const holder = db
      .query<{ id: string; source: string }, [string]>(
        "SELECT id, source FROM finance_transactions WHERE dedupe_key = ?1",
      )
      .get(key);
    if (!holder) {
      const id = randomUUID();
      const result = insert(id, key);
      dedupe?.claimed.add(key);
      return {
        inserted: result.changes > 0,
        id,
        outcome: result.changes > 0 ? "inserted" : "duplicate-source",
      };
    }
    if (holder.source === input.source) continue;
    dedupe?.claimed.add(key);
    return {
      inserted: false,
      id: holder.id,
      outcome: "duplicate-cross-source",
    };
  }

  const id = randomUUID();
  const result = insert(id, null);
  return {
    inserted: result.changes > 0,
    id,
    outcome: result.changes > 0 ? "inserted" : "duplicate-source",
  };
}

// Identity: (source, account_id, symbol).
export function upsertFinancePosition(
  input: CanonicalPositionInput,
  now = new Date(),
): string {
  const db = getDatabase();
  const timestamp = now.toISOString();
  const existing = db
    .query<{ id: string }, [string, string, string]>(
      "SELECT id FROM finance_positions WHERE source = ?1 AND account_id = ?2 AND symbol = ?3",
    )
    .get(input.source, input.accountId, input.symbol);
  const id = existing?.id ?? randomUUID();
  db.query(
    `
    INSERT INTO finance_positions (id, account_id, source, source_id, source_variant, symbol, name, quantity, market_value, average_cost, currency, import_id, observed_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    ON CONFLICT(id) DO UPDATE SET
      account_id = excluded.account_id,
      source_id = COALESCE(excluded.source_id, finance_positions.source_id),
      source_variant = COALESCE(excluded.source_variant, finance_positions.source_variant),
      name = excluded.name,
      quantity = excluded.quantity,
      market_value = excluded.market_value,
      average_cost = excluded.average_cost,
      currency = excluded.currency,
      import_id = COALESCE(excluded.import_id, finance_positions.import_id),
      observed_at = excluded.observed_at,
      updated_at = excluded.updated_at
  `,
  ).run(
    id,
    input.accountId,
    input.source,
    input.sourceId ?? null,
    input.sourceVariant ?? null,
    input.symbol,
    input.name ?? null,
    input.quantity,
    input.marketValue ?? null,
    input.averageCost ?? null,
    normalizeCurrency(input.currency),
    input.importId ?? null,
    input.observedAt ?? timestamp,
    timestamp,
  );
  return id;
}

// Idempotent on UNIQUE(source, fingerprint): inserted=false means a duplicate.
export function upsertFinanceActivity(
  input: CanonicalActivityInput,
  now = new Date(),
): { inserted: boolean; id: string } {
  const timestamp = now.toISOString();
  const id = randomUUID();
  const result = getDatabase()
    .query(
      `
      INSERT OR IGNORE INTO finance_activities (id, account_id, source, source_id, source_variant, import_id, type, description, amount, currency, symbol, quantity, price, fingerprint, status, occurred_at, settled_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)
    `,
    )
    .run(
      id,
      input.accountId ?? null,
      input.source,
      input.sourceId ?? null,
      input.sourceVariant ?? null,
      input.importId ?? null,
      input.type,
      input.description ?? null,
      input.amount ?? null,
      normalizeCurrency(input.currency),
      input.symbol ?? null,
      input.quantity ?? null,
      input.price ?? null,
      input.fingerprint,
      input.status ?? "posted",
      normalizeDate(input.occurredAt),
      input.settledAt ? normalizeDate(input.settledAt) : null,
      timestamp,
    );
  return { inserted: result.changes > 0, id };
}

export function deleteFinanceActivity(
  source: string,
  fingerprint: string,
): boolean {
  const result = getDatabase()
    .query(
      "DELETE FROM finance_activities WHERE source = ?1 AND fingerprint = ?2",
    )
    .run(source, fingerprint);
  return result.changes > 0;
}

export class FinanceLinkError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "FinanceLinkError";
  }
}

export class FinanceImportUndoError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = "FinanceImportUndoError";
  }
}

type ImportUndoReceiptRow = {
  id: string;
  source: string;
  status: string;
  accountId: string | null;
  createdAt: string;
};

function maybeDeleteLegacyCsvAccount(
  receipt: ImportUndoReceiptRow,
): string | null {
  if (!receipt.accountId) return null;
  const db = getDatabase();
  const account = db
    .query<{ id: string }, [string, string, string]>(
      `
      SELECT id
      FROM finance_accounts
      WHERE id = ?1
        AND source = 'csv'
        AND import_id = ?2
        AND created_at = ?3
        AND NOT EXISTS (
          SELECT 1 FROM finance_imports
          WHERE account_id = finance_accounts.id
            AND id <> ?2
            AND status <> 'undone'
        )
        AND NOT EXISTS (SELECT 1 FROM finance_transactions WHERE account_id = finance_accounts.id)
        AND NOT EXISTS (SELECT 1 FROM finance_positions WHERE account_id = finance_accounts.id)
        AND NOT EXISTS (SELECT 1 FROM finance_activities WHERE account_id = finance_accounts.id)
        AND NOT EXISTS (SELECT 1 FROM finance_account_links WHERE account_id = finance_accounts.id OR canonical_account_id = finance_accounts.id)
        AND NOT EXISTS (SELECT 1 FROM finance_account_return_rates WHERE account_id = finance_accounts.id)
        AND NOT EXISTS (SELECT 1 FROM finance_balances WHERE account_id = finance_accounts.id)
        AND NOT EXISTS (SELECT 1 FROM finance_account_value_history WHERE account_id = finance_accounts.id)
    `,
    )
    .get(receipt.accountId, receipt.id, receipt.createdAt);
  if (!account) return null;
  const deleted = db
    .query("DELETE FROM finance_accounts WHERE id = ?1 AND source = 'csv'")
    .run(account.id);
  return deleted.changes > 0 ? account.id : null;
}

export function undoFinanceImport(
  importId: string,
  now = new Date(),
): {
  ok: true;
  importId: string;
  deletedTransactions: number;
  deletedAccountId: string | null;
} {
  const db = getDatabase();
  const timestamp = now.toISOString();
  let deletedTransactions = 0;
  let deletedAccountId: string | null = null;
  db.transaction(() => {
    const receipt = db
      .query<ImportUndoReceiptRow, [string]>(
        "SELECT id, source, status, account_id AS accountId, created_at AS createdAt FROM finance_imports WHERE id = ?1",
      )
      .get(importId);
    if (!receipt) throw new FinanceImportUndoError("import not found", 404);
    if (receipt.source !== "csv")
      throw new FinanceImportUndoError("import is not a csv import", 409);

    const deleted = db
      .query(
        "DELETE FROM finance_transactions WHERE import_id = ?1 AND source = 'csv'",
      )
      .run(importId);
    deletedTransactions = deleted.changes;
    db.query(
      "DELETE FROM finance_balances WHERE import_id = ?1 AND source = 'csv'",
    ).run(importId);
    db.query(
      "DELETE FROM finance_account_value_history WHERE import_id = ?1 AND source = 'csv'",
    ).run(importId);

    deletedAccountId = maybeDeleteLegacyCsvAccount(receipt);

    db.query(
      `
      UPDATE finance_imports SET
        status = 'undone',
        imported_count = 0,
        error = NULL,
        finished_at = ?2,
        updated_at = ?2
      WHERE id = ?1
    `,
    ).run(importId, timestamp);
  })();
  return { ok: true, importId, deletedTransactions, deletedAccountId };
}

type LinkAccountRow = {
  id: string;
  currency: string;
  type: string;
  source: string;
  institution: string | null;
  mask: string | null;
};
type LinkRow = { account_id: string; canonical_account_id: string };
type LinkTransactionRow = {
  id: string;
  source: string;
  description: string;
  amount: number;
  currency: string;
  posted_at: string;
  created_at: string;
  dedupe_key: string | null;
};

function readFinanceAccount(id: string): LinkAccountRow | null {
  return (
    getDatabase()
      .query<LinkAccountRow, [string]>(
        "SELECT id, currency, type, source, institution, mask FROM finance_accounts WHERE id = ?1",
      )
      .get(id) ?? null
  );
}

export function linkFinanceAccounts(
  input: {
    canonicalAccountId: string;
    duplicateAccountId: string;
    method?: "manual" | "identity";
  },
  now = new Date(),
): {
  linked: true;
  canonicalAccountId: string;
  duplicateAccountId: string;
  transactionsMerged: number;
  transactionsRekeyed: number;
} {
  const db = getDatabase();
  const canonical = readFinanceAccount(input.canonicalAccountId);
  const duplicate = readFinanceAccount(input.duplicateAccountId);
  if (!canonical || !duplicate)
    throw new FinanceLinkError("account not found", 404);
  if (canonical.id === duplicate.id)
    throw new FinanceLinkError("accounts must differ", 400);
  const existing = db
    .query<LinkRow, [string]>(
      "SELECT account_id, canonical_account_id FROM finance_account_links WHERE account_id = ?1",
    )
    .get(duplicate.id);
  if (existing?.canonical_account_id === canonical.id)
    return {
      linked: true,
      canonicalAccountId: canonical.id,
      duplicateAccountId: duplicate.id,
      transactionsMerged: 0,
      transactionsRekeyed: 0,
    };
  if (existing)
    throw new FinanceLinkError("duplicate account is already linked", 409);
  if (
    db
      .query<LinkRow, [string]>(
        "SELECT account_id, canonical_account_id FROM finance_account_links WHERE account_id = ?1",
      )
      .get(canonical.id)
  )
    throw new FinanceLinkError("link to the root account", 409);
  if (
    db
      .query<LinkRow, [string]>(
        "SELECT account_id, canonical_account_id FROM finance_account_links WHERE canonical_account_id = ?1",
      )
      .get(duplicate.id)
  )
    throw new FinanceLinkError("unlink its duplicates first", 409);
  if (
    normalizeCurrency(canonical.currency) !==
    normalizeCurrency(duplicate.currency)
  )
    throw new FinanceLinkError("account currencies must match", 409);

  const timestamp = now.toISOString();
  let merged = 0;
  let rekeyed = 0;
  db.transaction(() => {
    db.query(
      `INSERT INTO finance_account_links (account_id, canonical_account_id, method, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).run(duplicate.id, canonical.id, input.method ?? "manual", timestamp);
    db.query(
      "UPDATE finance_transactions SET account_id = ?1, updated_at = ?2 WHERE account_id = ?3",
    ).run(canonical.id, timestamp, duplicate.id);
    const rows = db
      .query<LinkTransactionRow, [string]>(
        "SELECT id, source, description, amount, currency, posted_at, created_at, dedupe_key FROM finance_transactions WHERE account_id = ?1",
      )
      .all(canonical.id);
    const groups = new Map<string, LinkTransactionRow[]>();
    for (const row of rows) {
      const sig = transactionSignature(
        canonical.id,
        row.posted_at,
        row.currency,
        row.amount,
        row.description,
      );
      const group = groups.get(sig);
      if (group) group.push(row);
      else groups.set(sig, [row]);
    }
    for (const group of groups.values()) {
      const sources = new Map<string, LinkTransactionRow[]>();
      for (const row of group) {
        const list = sources.get(row.source);
        if (list) list.push(row);
        else sources.set(row.source, [row]);
      }
      if (sources.size > 1) {
        const ordered = [...sources.entries()].sort(
          (a, b) =>
            b[1].length - a[1].length ||
            a[1]
              .reduce(
                (m, r) => (r.created_at < m ? r.created_at : m),
                a[1][0].created_at,
              )
              .localeCompare(
                b[1].reduce(
                  (m, r) => (r.created_at < m ? r.created_at : m),
                  b[1][0].created_at,
                ),
              ) ||
            a[0].localeCompare(b[0]),
        );
        const keep = ordered[0][0];
        for (const [source, rowsForSource] of ordered) {
          if (source === keep) continue;
          for (const row of rowsForSource) {
            db.query("DELETE FROM finance_transactions WHERE id = ?1").run(
              row.id,
            );
            merged += 1;
          }
        }
      }
    }
    const survivors = db
      .query<LinkTransactionRow, [string]>(
        "SELECT id, source, description, amount, currency, posted_at, created_at, dedupe_key FROM finance_transactions WHERE account_id = ?1",
      )
      .all(canonical.id);
    const survivorGroups = new Map<string, LinkTransactionRow[]>();
    for (const row of survivors) {
      const sig = transactionSignature(
        canonical.id,
        row.posted_at,
        row.currency,
        row.amount,
        row.description,
      );
      const group = survivorGroups.get(sig);
      if (group) group.push(row);
      else survivorGroups.set(sig, [row]);
    }
    for (const [sig, group] of survivorGroups) {
      db.query(
        `UPDATE finance_transactions SET dedupe_key = NULL WHERE id IN (${group.map(() => "?").join(",")})`,
      ).run(...group.map((row) => row.id));
      group.sort(
        (a, b) =>
          a.posted_at.localeCompare(b.posted_at) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id),
      );
      group.forEach((row, index) => {
        db.query(
          "UPDATE finance_transactions SET dedupe_key = ?1, updated_at = ?2 WHERE id = ?3",
        ).run(dedupeKeyFor(sig, index + 1), timestamp, row.id);
        rekeyed += 1;
      });
    }
  })();
  return {
    linked: true,
    canonicalAccountId: canonical.id,
    duplicateAccountId: duplicate.id,
    transactionsMerged: merged,
    transactionsRekeyed: rekeyed,
  };
}

export function unlinkFinanceAccount(
  accountId: string,
  now = new Date(),
): boolean {
  void now;
  const result = getDatabase()
    .query("DELETE FROM finance_account_links WHERE account_id = ?1")
    .run(accountId);
  return result.changes > 0;
}

export function autoLinkFinanceAccount(
  accountId: string,
  now = new Date(),
): { status: "linked" | "skipped" | "ambiguous"; duplicateAccountId?: string } {
  const db = getDatabase();
  const self = readFinanceAccount(accountId);
  const institution = self?.institution;
  if (!institution || !self.mask) return { status: "skipped" };
  if (
    db
      .query<LinkRow, [string]>(
        "SELECT account_id, canonical_account_id FROM finance_account_links WHERE account_id = ?1",
      )
      .get(accountId)
  )
    return { status: "skipped" };
  const mask = normalizeMask(self.mask);
  const candidates = db
    .query<LinkAccountRow, [string, string, string, string]>(
      `
    SELECT id, currency, type, source, institution, mask
    FROM finance_accounts
    WHERE id != ?1 AND source != ?2 AND currency = ?3 AND type = ?4 AND institution IS NOT NULL AND mask IS NOT NULL
  `,
    )
    .all(accountId, self.source, self.currency, self.type)
    .filter((candidate) => {
      if (!candidate.institution || normalizeMask(candidate.mask) !== mask)
        return false;
      if (slugifyName(candidate.institution) !== slugifyName(institution))
        return false;
      const candidateLink = db
        .query<LinkRow, [string]>(
          "SELECT account_id, canonical_account_id FROM finance_account_links WHERE account_id = ?1",
        )
        .get(candidate.id);
      if (candidateLink?.canonical_account_id === accountId) return false;
      if (candidateLink) return false;
      if (
        db
          .query<LinkRow, [string]>(
            "SELECT account_id, canonical_account_id FROM finance_account_links WHERE canonical_account_id = ?1",
          )
          .get(candidate.id)
      )
        return false;
      return true;
    });
  if (candidates.length === 0) return { status: "skipped" };
  if (candidates.length > 1) return { status: "ambiguous" };
  linkFinanceAccounts(
    {
      canonicalAccountId: accountId,
      duplicateAccountId: candidates[0].id,
      method: "identity",
    },
    now,
  );
  return { status: "linked", duplicateAccountId: candidates[0].id };
}

export function upsertFinanceAccountHistory(
  input: CanonicalAccountHistoryInput,
  now = new Date(),
): void {
  const timestamp = now.toISOString();
  getDatabase()
    .query(
      `
      INSERT INTO finance_account_value_history
        (id, account_id, source, source_variant, date, equity, cash, currency, import_id, observed_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
      ON CONFLICT(source, account_id, date) DO UPDATE SET
        source_variant = COALESCE(excluded.source_variant, finance_account_value_history.source_variant),
        equity = excluded.equity,
        cash = excluded.cash,
        currency = excluded.currency,
        import_id = COALESCE(excluded.import_id, finance_account_value_history.import_id),
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      randomUUID(),
      input.accountId,
      input.source,
      input.sourceVariant ?? null,
      input.date,
      input.equity,
      input.cash ?? null,
      normalizeCurrency(input.currency),
      input.importId ?? null,
      input.observedAt ?? timestamp,
      timestamp,
    );
}

export function upsertFinanceAccountReturnRate(
  input: CanonicalAccountReturnRateInput,
  now = new Date(),
): void {
  const timestamp = now.toISOString();
  getDatabase()
    .query(
      `
      INSERT INTO finance_account_return_rates
        (id, account_id, source, source_variant, timeframe, return_percent, as_of, import_id, observed_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
      ON CONFLICT(source, account_id, timeframe) DO UPDATE SET
        source_variant = COALESCE(excluded.source_variant, finance_account_return_rates.source_variant),
        return_percent = excluded.return_percent,
        as_of = excluded.as_of,
        import_id = COALESCE(excluded.import_id, finance_account_return_rates.import_id),
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      randomUUID(),
      input.accountId,
      input.source,
      input.sourceVariant ?? null,
      input.timeframe.toUpperCase(),
      input.returnPercent,
      input.asOf ?? null,
      input.importId ?? null,
      input.observedAt ?? timestamp,
      timestamp,
    );
}

// ---------------------------------------------------------------------------
// CSV import: provider='csv', bank format preserved as source_variant.
// ---------------------------------------------------------------------------

export function importFinanceCsv(
  input: CsvImportInput,
  now = new Date(),
): {
  imported: number;
  skippedDuplicates: number;
  accountId: string;
  importId: string;
  status: string;
  skippedCrossSource: number;
} {
  const timestamp = now.toISOString();
  const sourceVariant = input.source;
  const account = readVisibleFinanceAccount(input.accountId);
  if (!account) throw new FinanceLinkError("account not found", 404);
  const accountId = account.id;
  const accountCurrency = normalizeCurrency(account.currency);
  if (
    input.transactions.some(
      (transaction) =>
        normalizeCurrency(transaction.currency) !== accountCurrency,
    )
  ) {
    throw new FinanceLinkError(
      "transaction currency does not match account",
      409,
    );
  }
  const balance =
    typeof input.balance === "number" && Number.isFinite(input.balance)
      ? input.balance
      : null;
  const importId = createImportBatch(
    { source: "csv", sourceVariant, accountId, status: "pending" },
    now,
  );
  if (balance != null) {
    getDatabase()
      .query(
        "UPDATE finance_accounts SET balance = ?2, observed_at = ?3, updated_at = ?3 WHERE id = ?1",
      )
      .run(accountId, balance, timestamp);
    upsertFinanceBalance(
      {
        accountId,
        currency: accountCurrency,
        cash: balance,
        source: "csv",
        sourceVariant,
        importId,
        observedAt: timestamp,
      },
      now,
    );
    upsertFinanceAccountHistory(
      {
        accountId,
        source: "csv",
        sourceVariant,
        date: timestamp.slice(0, 10),
        equity: balance,
        cash: null,
        currency: accountCurrency,
        importId,
        observedAt: timestamp,
      },
      now,
    );
  }
  let imported = 0;
  let skippedDuplicates = 0;
  let skippedCrossSource = 0;
  const dedupe: TransactionDedupeContext = { claimed: new Set<string>() };
  for (const transaction of input.transactions) {
    const result = upsertFinanceTransaction(
      {
        accountId,
        source: "csv",
        sourceId: transaction.externalId ?? null,
        sourceVariant,
        fingerprint: transaction.fingerprint,
        description: transaction.description,
        amount: transaction.amount,
        currency: transaction.currency,
        postedAt: transaction.date,
        category: transaction.category,
        importId,
      },
      now,
      dedupe,
    );
    if (result.outcome === "inserted") imported += 1;
    else if (result.outcome === "duplicate-cross-source")
      skippedCrossSource += 1;
    else skippedDuplicates += 1;
  }
  finalizeImportBatch(
    importId,
    {
      status: "completed",
      imported,
      skipped: skippedDuplicates + skippedCrossSource,
      accountId,
    },
    now,
  );
  return {
    imported,
    skippedDuplicates,
    skippedCrossSource,
    accountId,
    importId,
    status: "completed",
  };
}

export function parseCsvImport(value: unknown): CsvImportInput | null {
  const decoded = decodeUnknownResult(CsvImportInputSchema, value);
  if (!decoded.ok) return null;
  if (!decoded.value.accountId.trim()) return null;
  if (
    decoded.value.transactions.some((transaction) =>
      Number.isNaN(new Date(transaction.date).getTime()),
    )
  )
    return null;
  return {
    source: decoded.value.source,
    accountId: decoded.value.accountId.trim(),
    balance:
      typeof decoded.value.balance === "number" &&
      Number.isFinite(decoded.value.balance)
        ? decoded.value.balance
        : null,
    transactions: decoded.value.transactions.map((transaction) => ({
      externalId:
        typeof transaction.externalId === "string"
          ? transaction.externalId
          : null,
      fingerprint: transaction.fingerprint,
      date: transaction.date,
      description: transaction.description,
      amount: transaction.amount,
      category: transaction.category,
      currency: normalizeCurrency(transaction.currency),
    })),
  };
}

// ---------------------------------------------------------------------------
// Canonical dashboard read: raw records grouped by original currency, plus
// source freshness. Never sums across currencies. Columns are aliased to the
// record shape so query rows are the records with no post-mapping pass.
// ---------------------------------------------------------------------------

export function getFinanceDashboard(): FinanceDashboard {
  const db = getDatabase();
  const accounts = db
    .query<FinanceAccountRecord, []>(
      `
      SELECT id, source, source_id AS sourceId, source_variant AS sourceVariant, name, type, currency, balance,
             institution, mask, status, import_id AS importId, observed_at AS observedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM finance_accounts
      WHERE NOT EXISTS (SELECT 1 FROM finance_account_links l WHERE l.account_id = finance_accounts.id)
      ORDER BY updated_at DESC
    `,
    )
    .all();
  const balances = db
    .query<FinanceBalanceRecord, []>(
      `
      SELECT id, account_id AS accountId, currency, cash, buying_power AS buyingPower, observed_at AS observedAt,
             source, source_variant AS sourceVariant, import_id AS importId, updated_at AS updatedAt
      FROM finance_balances
      WHERE NOT EXISTS (SELECT 1 FROM finance_account_links l WHERE l.account_id = finance_balances.account_id)
      ORDER BY observed_at DESC
    `,
    )
    .all();
  const transactions = db
    .query<FinanceTransactionRecord, []>(
      `
      SELECT t.id, t.account_id AS accountId, t.source, t.source_variant AS sourceVariant, t.description, t.amount, t.currency,
             t.posted_at AS postedAt, t.category_id AS categoryId, c.name AS categoryName, c.group_name AS categoryGroup, t.status
      FROM finance_transactions t
      LEFT JOIN finance_categories c ON c.id = t.category_id
      ORDER BY t.posted_at DESC
    `,
    )
    .all();
  const categories = db
    .query<
      {
        id: string;
        name: string;
        group: string;
        excludeFromSpending: number;
        color: string | null;
      },
      []
    >(
      `
      SELECT id, name, group_name AS "group", exclude_from_spending AS excludeFromSpending, color
      FROM finance_categories ORDER BY group_name ASC, name ASC
    `,
    )
    .all()
    .map((row) => ({
      ...row,
      excludeFromSpending: row.excludeFromSpending === 1,
    }));
  const positions = db
    .query<FinancePositionRecord, []>(
      `
      SELECT id, account_id AS accountId, source, source_variant AS sourceVariant, symbol, name, quantity,
             market_value AS marketValue, average_cost AS averageCost, currency, observed_at AS observedAt, updated_at AS updatedAt
      FROM finance_positions
      WHERE NOT EXISTS (SELECT 1 FROM finance_account_links l WHERE l.account_id = finance_positions.account_id)
      ORDER BY symbol ASC
    `,
    )
    .all();
  const activities = db
    .query<FinanceActivityRecord, []>(
      `
      SELECT id, account_id AS accountId, source, source_variant AS sourceVariant, type, description, amount, currency,
             symbol, quantity, price, occurred_at AS occurredAt, settled_at AS settledAt, status
      FROM finance_activities ORDER BY occurred_at DESC
    `,
    )
    .all();
  const legacyHistory = db
    .query<FinanceHistoryRecord, []>(
      "SELECT NULL AS accountId, date, equity, cash, 'USD' AS currency, source FROM finance_portfolio_history",
    )
    .all();
  const accountHistory = db
    .query<FinanceHistoryRecord, []>(
      `
      SELECT account_id AS accountId, date, equity, cash, currency, source
      FROM finance_account_value_history
      WHERE NOT EXISTS (SELECT 1 FROM finance_account_links l WHERE l.account_id = finance_account_value_history.account_id)
    `,
    )
    .all();
  const history = [...legacyHistory, ...accountHistory].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const returnRates = db
    .query<FinanceAccountReturnRateRecord, []>(
      `
      SELECT account_id AS accountId, source, source_variant AS sourceVariant, timeframe,
             return_percent AS returnPercent, as_of AS asOf, observed_at AS observedAt, updated_at AS updatedAt
      FROM finance_account_return_rates
      WHERE NOT EXISTS (SELECT 1 FROM finance_account_links l WHERE l.account_id = finance_account_return_rates.account_id)
      ORDER BY account_id ASC, timeframe ASC
    `,
    )
    .all();
  const imports = db
    .query<FinanceImportRecord, []>(
      `
      SELECT id, source, source_variant AS sourceVariant, account_id AS accountId, status,
             imported_count AS importedCount, skipped_count AS skippedCount, error,
             started_at AS startedAt, finished_at AS finishedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM finance_imports ORDER BY created_at DESC
    `,
    )
    .all();
  const byCurrency = groupByCurrency(
    accounts,
    balances,
    transactions,
    positions,
    activities,
  );
  const sources = summarizeSources(accounts, transactions, imports);
  return {
    accounts,
    balances,
    transactions,
    categories,
    positions,
    activities,
    history,
    returnRates,
    imports,
    byCurrency,
    sources,
  };
}

function groupByCurrency(
  accounts: FinanceAccountRecord[],
  balances: FinanceBalanceRecord[],
  transactions: FinanceTransactionRecord[],
  positions: FinancePositionRecord[],
  activities: FinanceActivityRecord[],
): FinanceCurrencyGroup[] {
  const currencies = new Set<string>();
  for (const account of accounts) currencies.add(account.currency);
  for (const balance of balances) currencies.add(balance.currency);
  for (const transaction of transactions) currencies.add(transaction.currency);
  for (const position of positions) currencies.add(position.currency);
  for (const activity of activities) currencies.add(activity.currency);
  return Array.from(currencies)
    .sort()
    .map((currency) => ({
      currency,
      accounts: accounts.filter((record) => record.currency === currency),
      balances: balances.filter((record) => record.currency === currency),
      transactions: transactions.filter(
        (record) => record.currency === currency,
      ),
      positions: positions.filter((record) => record.currency === currency),
      activities: activities.filter((record) => record.currency === currency),
    }));
}

function summarizeSources(
  accounts: FinanceAccountRecord[],
  transactions: FinanceTransactionRecord[],
  imports: FinanceImportRecord[],
): FinanceSourceFreshness[] {
  const byKey = new Map<string, FinanceSourceFreshness>();
  const ensure = (
    source: string,
    variant: string | null,
  ): FinanceSourceFreshness => {
    const key = `${source}\u0000${variant ?? ""}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        source,
        sourceVariant: variant,
        accountCount: 0,
        transactionCount: 0,
        lastObservedAt: null,
        lastImportedAt: null,
      };
      byKey.set(key, entry);
    }
    return entry;
  };
  const newer = (a: string | null, b: string | null): string | null =>
    !a ? b : !b ? a : a >= b ? a : b;
  for (const account of accounts) {
    const entry = ensure(account.source, account.sourceVariant);
    entry.accountCount += 1;
    entry.lastObservedAt = newer(
      entry.lastObservedAt,
      account.observedAt ?? account.updatedAt,
    );
  }
  for (const transaction of transactions) {
    const entry = ensure(transaction.source, transaction.sourceVariant);
    entry.transactionCount += 1;
    entry.lastObservedAt = newer(entry.lastObservedAt, transaction.postedAt);
  }
  for (const record of imports) {
    const entry = ensure(record.source, record.sourceVariant);
    entry.lastImportedAt = newer(
      entry.lastImportedAt,
      record.finishedAt ?? record.createdAt,
    );
  }
  return Array.from(byKey.values()).sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      (a.sourceVariant ?? "").localeCompare(b.sourceVariant ?? ""),
  );
}
