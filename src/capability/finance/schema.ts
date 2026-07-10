import { Schema } from "effect";

// CSV bank format identifier. In canonical storage this is persisted as
// `source_variant` under the provider `source = "csv"` — never as the source.
export const FinanceSourceSchema = Schema.Literal(
  "chase_cc",
  "chase_checking",
  "td_canada",
  "wealthsimple",
  "manual",
);

// Canonical account types shared across every provider.
export const FinanceAccountTypeSchema = Schema.Literal(
  "checking",
  "savings",
  "credit",
  "investment",
  "crypto",
  "loan",
);

export const FinanceAccountStatusSchema = Schema.Literal("hidden", "active");

// Broadened from the old closed CAD/USD/BTC literal to any uppercase ISO-like
// currency code (ISO 4217 three-letter codes) plus crypto tickers such as BTC.
export const FinanceCurrencySchema = Schema.String.pipe(
  Schema.pattern(/^[A-Z]{3,5}$/),
);

export const FinanceImportIdSchema = Schema.String.pipe(Schema.pattern(/^.+$/));

const OptionalString = Schema.optional(
  Schema.Union(Schema.String, Schema.Null),
);
const OptionalNumber = Schema.optional(
  Schema.Union(Schema.Number, Schema.Null),
);

export const CsvTransactionInputSchema = Schema.Struct({
  externalId: OptionalString,
  fingerprint: Schema.String,
  date: Schema.String,
  description: Schema.String,
  amount: Schema.Number,
  category: Schema.String,
  currency: FinanceCurrencySchema,
});

export const CsvImportInputSchema = Schema.Struct({
  source: FinanceSourceSchema,
  accountId: Schema.String,
  balance: OptionalNumber,
  transactions: Schema.Array(CsvTransactionInputSchema),
});

export const CreateFinanceAccountInputSchema = Schema.Struct({
  name: Schema.String,
  type: FinanceAccountTypeSchema,
  currency: Schema.String,
  balance: OptionalNumber,
});

export const UpdateFinanceAccountInputSchema = Schema.Struct({
  status: Schema.optional(FinanceAccountStatusSchema),
  name: Schema.optional(Schema.String),
  balance: Schema.optional(Schema.Union(Schema.Number, Schema.Null)),
});

// --- Provider-neutral canonical inputs (CSV today, SnapTrade et al. later) ---
// `source` is the canonical provider (e.g. "csv" | "snaptrade") and stays an
// open string so new providers need no schema change.

export const CanonicalImportInputSchema = Schema.Struct({
  source: Schema.String,
  sourceVariant: OptionalString,
  accountId: OptionalString,
  status: Schema.optional(Schema.String),
});

export const CanonicalAccountInputSchema = Schema.Struct({
  source: Schema.String,
  sourceId: OptionalString,
  sourceVariant: OptionalString,
  name: Schema.String,
  type: FinanceAccountTypeSchema,
  currency: FinanceCurrencySchema,
  balance: OptionalNumber,
  institution: OptionalString,
  mask: OptionalString,
  status: Schema.optional(Schema.String),
  importId: OptionalString,
  observedAt: OptionalString,
});

export const CanonicalBalanceInputSchema = Schema.Struct({
  accountId: Schema.String,
  currency: FinanceCurrencySchema,
  cash: OptionalNumber,
  buyingPower: OptionalNumber,
  source: Schema.String,
  sourceVariant: OptionalString,
  importId: OptionalString,
  observedAt: OptionalString,
});

export const CanonicalTransactionInputSchema = Schema.Struct({
  accountId: OptionalString,
  source: Schema.String,
  sourceId: OptionalString,
  sourceVariant: OptionalString,
  fingerprint: Schema.String,
  description: Schema.String,
  amount: Schema.Number,
  currency: FinanceCurrencySchema,
  postedAt: Schema.String,
  category: OptionalString,
  status: Schema.optional(Schema.String),
  notes: OptionalString,
  importId: OptionalString,
});

export const CanonicalPositionInputSchema = Schema.Struct({
  accountId: Schema.String,
  source: Schema.String,
  sourceId: OptionalString,
  sourceVariant: OptionalString,
  symbol: Schema.String,
  name: OptionalString,
  quantity: Schema.Number,
  marketValue: OptionalNumber,
  averageCost: OptionalNumber,
  currency: FinanceCurrencySchema,
  importId: OptionalString,
  observedAt: OptionalString,
});

export const CanonicalActivityInputSchema = Schema.Struct({
  accountId: OptionalString,
  source: Schema.String,
  sourceId: OptionalString,
  sourceVariant: OptionalString,
  type: Schema.String,
  description: OptionalString,
  amount: OptionalNumber,
  currency: FinanceCurrencySchema,
  symbol: OptionalString,
  quantity: OptionalNumber,
  price: OptionalNumber,
  fingerprint: Schema.String,
  status: Schema.optional(Schema.String),
  occurredAt: Schema.String,
  settledAt: OptionalString,
  importId: OptionalString,
});

export const FinanceAccountLinkInputSchema = Schema.Struct({
  canonicalAccountId: Schema.String,
  duplicateAccountId: Schema.String,
});

export const CanonicalAccountHistoryInputSchema = Schema.Struct({
  accountId: Schema.String,
  source: Schema.String,
  sourceVariant: OptionalString,
  date: Schema.String,
  equity: Schema.Number,
  cash: OptionalNumber,
  currency: FinanceCurrencySchema,
  importId: OptionalString,
  observedAt: OptionalString,
});

export const CanonicalAccountReturnRateInputSchema = Schema.Struct({
  accountId: Schema.String,
  source: Schema.String,
  sourceVariant: OptionalString,
  timeframe: Schema.String,
  returnPercent: Schema.Number,
  asOf: OptionalString,
  importId: OptionalString,
  observedAt: OptionalString,
});

export const CanonicalCategoryInputSchema = Schema.Struct({
  name: Schema.String,
  group: Schema.optional(Schema.String),
  excludeFromSpending: Schema.optional(Schema.Boolean),
  color: OptionalString,
});

export type FinanceAccountType = typeof FinanceAccountTypeSchema.Type;
export type FinanceAccountStatus = typeof FinanceAccountStatusSchema.Type;
export type FinanceCurrency = typeof FinanceCurrencySchema.Type;
export type CsvImportBody = typeof CsvImportInputSchema.Type;
export type CreateFinanceAccountInput =
  typeof CreateFinanceAccountInputSchema.Type;
export type UpdateFinanceAccountInput =
  typeof UpdateFinanceAccountInputSchema.Type;
export type FinanceAccountLinkInput = typeof FinanceAccountLinkInputSchema.Type;
export type FinanceImportId = typeof FinanceImportIdSchema.Type;
export type CanonicalImportInput = typeof CanonicalImportInputSchema.Type;
export type CanonicalAccountInput = typeof CanonicalAccountInputSchema.Type;
export type CanonicalBalanceInput = typeof CanonicalBalanceInputSchema.Type;
export type CanonicalTransactionInput =
  typeof CanonicalTransactionInputSchema.Type;
export type CanonicalPositionInput = typeof CanonicalPositionInputSchema.Type;
export type CanonicalActivityInput = typeof CanonicalActivityInputSchema.Type;
export type CanonicalAccountHistoryInput =
  typeof CanonicalAccountHistoryInputSchema.Type;
export type CanonicalAccountReturnRateInput =
  typeof CanonicalAccountReturnRateInputSchema.Type;
export type CanonicalCategoryInput = typeof CanonicalCategoryInputSchema.Type;
