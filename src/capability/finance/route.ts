import { decodeUnknownResult } from "../../core/effect/schema";
import { emitInvalidation } from "../../core/events/events";
import { json, parseJsonRequest } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import {
  createFinanceAccount,
  deleteFinanceAccount,
  FinanceImportUndoError,
  FinanceLinkError,
  importFinanceCsv,
  linkFinanceAccounts,
  parseCsvImport,
  updateFinanceAccount,
  undoFinanceImport,
  unlinkFinanceAccount,
} from "./data";
import {
  CreateFinanceAccountInputSchema,
  FinanceAccountLinkInputSchema,
  FinanceImportIdSchema,
  UpdateFinanceAccountInputSchema,
} from "./schema";

export function financeRoutes(): RouteRegistrar {
  return (route) => {
    route.post("/v1/finance/imports/csv", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const input = parseCsvImport(parsed.value);
      if (!input) return json({ error: "invalid finance import" }, 400);
      try {
        const result = importFinanceCsv(input);
        emitInvalidation({
          type: "finance.changed",
          entityId: result.accountId,
          domain: "finance",
        });
        return json(result, 201);
      } catch (error) {
        if (error instanceof FinanceLinkError)
          return json({ error: error.message }, error.status);
        throw error;
      }
    });

    route.delete("/v1/finance/imports/:importId", (c) => {
      const importId = decodeUnknownResult(
        FinanceImportIdSchema,
        c.req.param("importId"),
      );
      if (!importId.ok) return json({ error: importId.error.message }, 400);
      try {
        const result = undoFinanceImport(importId.value);
        emitInvalidation({
          type: "finance.changed",
          entityId: result.importId,
          domain: "finance",
        });
        return json(result);
      } catch (error) {
        if (error instanceof FinanceImportUndoError)
          return json({ error: error.message }, error.status);
        throw error;
      }
    });

    route.post("/v1/finance/accounts", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const decoded = decodeUnknownResult(
        CreateFinanceAccountInputSchema,
        parsed.value,
      );
      if (!decoded.ok) return json({ error: decoded.error.message }, 400);
      try {
        const account = createFinanceAccount(decoded.value);
        emitInvalidation({
          type: "finance.changed",
          entityId: account.id,
          domain: "finance",
        });
        return json({ ok: true, account }, 201);
      } catch (error) {
        if (error instanceof FinanceLinkError)
          return json({ error: error.message }, error.status);
        throw error;
      }
    });

    route.post("/api/finance/accounts", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const decoded = decodeUnknownResult(
        CreateFinanceAccountInputSchema,
        parsed.value,
      );
      if (!decoded.ok) return json({ error: decoded.error.message }, 400);
      try {
        const account = createFinanceAccount(decoded.value);
        emitInvalidation({
          type: "finance.changed",
          entityId: account.id,
          domain: "finance",
        });
        return json({ ok: true, account }, 201);
      } catch (error) {
        if (error instanceof FinanceLinkError)
          return json({ error: error.message }, error.status);
        throw error;
      }
    });

    route.patch("/v1/finance/accounts/:accountId", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const decoded = decodeUnknownResult(
        UpdateFinanceAccountInputSchema,
        parsed.value,
      );
      if (!decoded.ok) return json({ error: decoded.error.message }, 400);
      if (
        decoded.value.status === undefined &&
        decoded.value.name === undefined &&
        !("balance" in decoded.value)
      ) {
        return json(
          { error: "account update requires at least one field" },
          400,
        );
      }
      const accountId = c.req.param("accountId");
      try {
        const account = updateFinanceAccount(accountId, decoded.value);
        emitInvalidation({
          type: "finance.changed",
          entityId: account.id,
          domain: "finance",
        });
        return json({ ok: true, account });
      } catch (error) {
        if (error instanceof FinanceLinkError)
          return json({ error: error.message }, error.status);
        throw error;
      }
    });

    route.delete("/v1/finance/accounts/:accountId", (c) => {
      const accountId = c.req.param("accountId");
      try {
        const result = deleteFinanceAccount(accountId);
        emitInvalidation({
          type: "finance.changed",
          entityId: accountId,
          domain: "finance",
        });
        return json(result);
      } catch (error) {
        if (error instanceof FinanceLinkError)
          return json({ error: error.message }, error.status);
        throw error;
      }
    });

    route.post("/v1/finance/accounts/links", async (c) => {
      const parsed = await parseJsonRequest(c.req.raw);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const decoded = decodeUnknownResult(
        FinanceAccountLinkInputSchema,
        parsed.value,
      );
      if (!decoded.ok) return json({ error: decoded.error.message }, 400);
      try {
        const result = linkFinanceAccounts({
          ...decoded.value,
          method: "manual",
        });
        emitInvalidation({
          type: "finance.changed",
          entityId: result.canonicalAccountId,
          domain: "finance",
        });
        return json(result, 201);
      } catch (error) {
        if (error instanceof FinanceLinkError)
          return json({ error: error.message }, error.status);
        throw error;
      }
    });

    route.delete("/v1/finance/accounts/links/:accountId", (c) => {
      const accountId = c.req.param("accountId");
      if (!unlinkFinanceAccount(accountId))
        return json({ error: "link not found" }, 404);
      emitInvalidation({
        type: "finance.changed",
        entityId: accountId,
        domain: "finance",
      });
      return json({ unlinked: true, accountId }, 200);
    });
  };
}
