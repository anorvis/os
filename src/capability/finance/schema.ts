import { Schema } from "effect";

export const FinanceSourceSchema = Schema.Literal("chase_cc", "chase_checking", "td_canada", "wealthsimple", "manual");
export const FinanceCurrencySchema = Schema.Literal("CAD", "USD", "BTC");

export const CsvTransactionInputSchema = Schema.Struct({
  externalId: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  fingerprint: Schema.String,
  date: Schema.String,
  description: Schema.String,
  amount: Schema.Number,
  category: Schema.String,
  currency: FinanceCurrencySchema,
});

export const CsvImportInputSchema = Schema.Struct({
  source: FinanceSourceSchema,
  accountName: Schema.String,
  balance: Schema.optional(Schema.Union(Schema.Number, Schema.Null)),
  transactions: Schema.Array(CsvTransactionInputSchema),
});

export type CsvImportBody = typeof CsvImportInputSchema.Type;
