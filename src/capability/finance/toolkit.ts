import { Schema } from "effect";
import {
  FinanceAccountStatusSchema,
  FinanceAccountTypeSchema,
  FinanceCurrencySchema,
  FinanceImportIdSchema,
  FinanceSourceSchema,
} from "./schema";
import {
  parametersFromSchema,
  type ToolkitTool,
} from "../../platform/toolkit/schema";

const FinanceDashboardQuerySchema = Schema.Struct({
  currency: FinanceCurrencySchema.annotations({
    description:
      "Required reporting currency code for the dashboard, e.g. USD, CAD, or BTC.",
  }),
});

const FinanceAccountCreateSchema = Schema.Struct({
  name: Schema.String.annotations({
    description: "Manual finance account name.",
  }),
  type: FinanceAccountTypeSchema.annotations({
    description: "Manual account type.",
  }),
  currency: FinanceCurrencySchema.annotations({
    description: "Account currency code, e.g. USD, CAD, or BTC.",
  }),
  balance: Schema.optional(
    Schema.Union(Schema.Number, Schema.Null).annotations({
      description: "Optional opening balance for the manual account.",
    }),
  ),
});

const FinanceAccountUpdateSchema = Schema.Struct({
  accountId: Schema.String.annotations({
    description: "Finance account id to update.",
  }),
  status: Schema.optional(
    FinanceAccountStatusSchema.annotations({
      description: "Updated account visibility status.",
    }),
  ),
  name: Schema.optional(
    Schema.String.annotations({
      description:
        "Updated manual account name; only manual accounts can be renamed.",
    }),
  ),
  balance: Schema.optional(
    Schema.Union(Schema.Number, Schema.Null).annotations({
      description:
        "Updated manual account balance; only manual account balances can be edited.",
    }),
  ),
});

const FinanceAccountDeleteSchema = Schema.Struct({
  accountId: Schema.String.annotations({
    description: "Manual finance account id to delete.",
  }),
});

const FinanceCsvTransactionSchema = Schema.Struct({
  externalId: Schema.optional(
    Schema.Union(Schema.String, Schema.Null).annotations({
      description: "Optional provider transaction id from the CSV source.",
    }),
  ),
  fingerprint: Schema.String.annotations({
    description: "Stable transaction fingerprint used for CSV de-duplication.",
  }),
  date: Schema.String.annotations({
    description: "Transaction date from the CSV file.",
  }),
  description: Schema.String.annotations({
    description: "Transaction description from the CSV file.",
  }),
  amount: Schema.Number.annotations({
    description: "Transaction amount in the transaction currency.",
  }),
  category: Schema.String.annotations({ description: "Transaction category." }),
  currency: FinanceCurrencySchema.annotations({
    description:
      "Transaction currency code; must match the selected account currency.",
  }),
});

const FinanceCsvImportSchema = Schema.Struct({
  source: FinanceSourceSchema.annotations({
    description: "CSV source format.",
  }),
  accountId: Schema.String.annotations({
    description:
      "Existing active finance account id to import these CSV transactions into.",
  }),
  balance: Schema.optional(
    Schema.Union(Schema.Number, Schema.Null).annotations({
      description: "Optional account balance observed with this CSV import.",
    }),
  ),
  transactions: Schema.Array(FinanceCsvTransactionSchema).annotations({
    description:
      "CSV transactions to import. Legacy accountName/accountCurrency fields are not accepted.",
  }),
});

const FinanceImportUndoSchema = Schema.Struct({
  importId: FinanceImportIdSchema.annotations({
    description: "CSV finance import id to undo.",
  }),
});

export const financeToolkitTools = [
  {
    id: "finance_dashboard.read",
    name: "anorvis_read_finance_dashboard",
    label: "Read Finance Dashboard",
    description:
      "Read the Finance dashboard in the requested reporting currency.",
    domain: "finance",
    operation: "read",
    resource: "finance_dashboard",
    mutates: false,
    method: "GET",
    path: "/v1/finance/dashboard",
    queryParams: ["currency"],
    parameters: parametersFromSchema(FinanceDashboardQuerySchema),
  },
  {
    id: "finance_account.list",
    name: "anorvis_list_finance_accounts",
    label: "List Finance Accounts",
    description:
      "List Finance accounts from the dashboard in the requested reporting currency.",
    domain: "finance",
    operation: "read",
    resource: "finance_account",
    mutates: false,
    method: "GET",
    path: "/v1/finance/dashboard",
    queryParams: ["currency"],
    parameters: parametersFromSchema(FinanceDashboardQuerySchema),
  },
  {
    id: "finance_account.create",
    name: "anorvis_create_finance_account",
    label: "Create Finance Account",
    description: "Create a manual Finance account in Anorvis OS.",
    domain: "finance",
    operation: "create",
    resource: "finance_account",
    mutates: true,
    method: "POST",
    path: "/v1/finance/accounts",
    parameters: parametersFromSchema(FinanceAccountCreateSchema),
  },
  {
    id: "finance_account.update",
    name: "anorvis_update_finance_account",
    label: "Update Finance Account",
    description:
      "Update a Finance account. At least one of status, name, or balance is required; name and balance edits are allowed only for manual accounts.",
    domain: "finance",
    operation: "update",
    resource: "finance_account",
    mutates: true,
    method: "PATCH",
    path: "/v1/finance/accounts/:accountId",
    pathParams: ["accountId"],
    parameters: parametersFromSchema(FinanceAccountUpdateSchema),
  },
  {
    id: "finance_account.delete",
    name: "anorvis_delete_finance_account",
    label: "Delete Finance Account",
    description:
      "Delete a manual Finance account and its account transactions. Only manual accounts can be deleted.",
    domain: "finance",
    operation: "delete",
    resource: "finance_account",
    mutates: true,
    method: "DELETE",
    path: "/v1/finance/accounts/:accountId",
    pathParams: ["accountId"],
    parameters: parametersFromSchema(FinanceAccountDeleteSchema),
  },
  {
    id: "finance_import.create_csv",
    name: "anorvis_import_finance_csv",
    label: "Import Finance CSV",
    description:
      "Import CSV transactions into an existing active Finance account. Requires accountId and does not accept legacy accountName/accountCurrency fields.",
    domain: "finance",
    operation: "create",
    resource: "finance_import",
    mutates: true,
    method: "POST",
    path: "/v1/finance/imports/csv",
    parameters: parametersFromSchema(FinanceCsvImportSchema),
  },
  {
    id: "finance_import.undo",
    name: "anorvis_undo_finance_import",
    label: "Undo Finance Import",
    description:
      "Undo a CSV Finance import by deleting the imported CSV transactions and balance history for that import.",
    domain: "finance",
    operation: "delete",
    resource: "finance_import",
    mutates: true,
    method: "DELETE",
    path: "/v1/finance/imports/:importId",
    pathParams: ["importId"],
    parameters: parametersFromSchema(FinanceImportUndoSchema),
  },
] satisfies ToolkitTool[];
