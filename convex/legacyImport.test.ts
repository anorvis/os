import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

function emptyPayload() {
  return {
    tasks: [], taskSessions: [], calendarEvents: [], lifeTags: [], meals: [], macroProfiles: [], bodyMeasurements: [], workouts: [], recipes: [],
    financeCategories: [], financeAccounts: [], financeTransactions: [], financeImports: [], financeBalances: [], financePositions: [], financeActivities: [], financeAccountValueHistory: [], financeAccountReturnRates: [],
    providerConnections: [], wikiPages: [], wikiSources: [],
  };
}

async function owner() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "owner@example.test" }));
  const client = t.withIdentity({ subject: userId });
  await client.mutation(api.workspaces.ensureDefault, {});
  return { t, client };
}

describe("legacy SQLite import", () => {
  test("is idempotent and preserves task/finance/wiki relationships", async () => {
    const { t, client } = await owner();
    const payload = emptyPayload();
    payload.tasks.push({ legacyId: "task-1", title: "Legacy task", status: "open", source: "manual", links: [], multiSession: true, createdAt: 100, updatedAt: 200 });
    payload.taskSessions.push({ legacyId: "session-1", taskLegacyId: "task-1", startAt: 1_000, endAt: 2_000, status: "planned", source: "manual", createdAt: 100, updatedAt: 200 });
    payload.financeCategories.push({ legacyId: "cat-1", name: "Groceries", group: "spending", excludeFromSpending: false });
    payload.financeAccounts.push({ legacyId: "acct-1", legacyImportId: "imp-1", source: "csv", sourceId: "legacy-account", name: "Checking", type: "checking", currency: "CAD", status: "active", createdAt: 100, updatedAt: 200 });
    payload.financeImports.push({ legacyId: "imp-1", legacyAccountId: "acct-1", source: "csv", status: "undone", importedCount: 1, skippedCount: 2, startedAt: 50, createdAt: 50, updatedAt: 60 });
    payload.financeTransactions.push({ legacyId: "tx-1", legacyAccountId: "acct-1", legacyImportId: "imp-1", source: "csv", sourceId: "legacy-tx", fingerprint: "fp-1", description: "Store", amount: -12.34, currency: "CAD", postedAt: 3_000, legacyCategoryId: "cat-1", status: "posted", createdAt: 100, updatedAt: 200 });
    payload.wikiPages.push({ path: "Notes/Legacy.md", markdown: "# Legacy\n\n#imported", aliases: ["Old Legacy"], tags: ["imported"], createdAt: 100, updatedAt: 200 });

    const first = await client.mutation(api.legacyImport.applyBatch, payload);
    const second = await client.mutation(api.legacyImport.applyBatch, payload);
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    expect(first.inserted).toBe(7);
    expect(second.inserted).toBe(0);
    const stored = await t.run(async (ctx) => {
      const tasks = await ctx.db.query("tasks").collect();
      const sessions = await ctx.db.query("taskSessions").collect();
      const accounts = await ctx.db.query("financeAccounts").collect();
      const imports = await ctx.db.query("financeImportJobs").collect();
      const transactions = await ctx.db.query("financeTransactions").collect();
      const pages = await ctx.db.query("wikiPages").collect();
      const aliases = await ctx.db.query("wikiPageAliases").collect();
      return { tasks, sessions, accounts, imports, transactions, pages, aliases };
    });
    expect(stored.sessions[0].taskId).toBe(stored.tasks[0]._id);
    expect(stored.imports[0].status).toBe("cancelled");
    expect(stored.imports[0].accountId).toBe(stored.accounts[0]._id);
    expect(stored.accounts[0].importJobId).toBe(stored.imports[0]._id);
    expect(stored.transactions[0].accountId).toBe(stored.accounts[0]._id);
    expect(stored.transactions[0].importJobId).toBe(stored.imports[0]._id);
    expect(stored.transactions[0].categoryId).toBeDefined();
    expect(stored.aliases[0].pageId).toBe(stored.pages[0]._id);
    if (stored.pages[0].currentRevisionId === undefined) throw new Error("Missing imported revision");
    await t.mutation(internal.wiki.indexRevision, { pageId: stored.pages[0]._id, revisionId: stored.pages[0].currentRevisionId });
    const pageChunks = await t.run(async (ctx) => ctx.db.query("wikiChunks").collect());
    expect(pageChunks.some((chunk) => chunk.revisionId === stored.pages[0].currentRevisionId)).toBe(true);
  });

  test("patches multiple accounts that point at a global import job", async () => {
    const { t, client } = await owner();
    const payload = emptyPayload();
    payload.financeAccounts.push(
      { legacyId: "acct-a", legacyImportId: "global-import", source: "csv", sourceId: "acct-a", name: "A", type: "checking", currency: "CAD", status: "active", createdAt: 100, updatedAt: 200 },
      { legacyId: "acct-b", legacyImportId: "global-import", source: "csv", sourceId: "acct-b", name: "B", type: "checking", currency: "CAD", status: "active", createdAt: 100, updatedAt: 200 },
    );
    payload.financeImports.push({ legacyId: "global-import", source: "csv", status: "completed", importedCount: 2, skippedCount: 0, startedAt: 50, createdAt: 50, updatedAt: 60 });

    await client.mutation(api.legacyImport.applyBatch, payload);

    const stored = await t.run(async (ctx) => ({
      accounts: await ctx.db.query("financeAccounts").collect(),
      imports: await ctx.db.query("financeImportJobs").collect(),
    }));
    expect(stored.imports[0].accountId).toBeUndefined();
    expect(stored.accounts.map((account) => account.importJobId)).toEqual([stored.imports[0]._id, stored.imports[0]._id]);
  });

  test("deduplicates local calendar events by their persisted provider identity", async () => {
    const { t, client } = await owner();
    const payload = emptyPayload();
    payload.calendarEvents.push({
      legacyId: "event-1",
      summary: "Legacy event",
      startAt: 1_000,
      endAt: 2_000,
      source: "manual",
      readOnly: false,
      provider: "local",
      allDay: false,
      createdAt: 100,
      updatedAt: 200,
    });

    await client.mutation(api.legacyImport.applyBatch, payload);
    await client.mutation(api.legacyImport.applyBatch, payload);

    const events = await t.run(async (ctx) => {
      const workspace = await ctx.db.query("workspaces").first();
      if (!workspace) throw new Error("Missing workspace");
      return ctx.db
        .query("calendarEvents")
        .withIndex("by_workspace_provider_event", (q) =>
          q
            .eq("workspaceId", workspace._id)
            .eq("provider", "local")
            .eq("providerEventId", "legacy:calendar_events:event-1"),
        )
        .collect();
    });
    expect(events).toHaveLength(1);
  });

  test("upserts provider credentials without exposing plaintext", async () => {
    const { t, client } = await owner();
    const payload = emptyPayload();
    const credentials = { algorithm: "aes-256-gcm", keyVersion: 1, nonce: "nonce", ciphertext: "ciphertext" };
    payload.providerConnections.push({ provider: "google", status: "connected", scopes: ["calendar"], accessTokenExpiresAt: 5_000, credentials, connectedAt: 1_000, updatedAt: 2_000 });
    await client.mutation(api.legacyImport.applyBatch, payload);
    await client.mutation(api.legacyImport.applyBatch, payload);
    const connections = await t.run(async (ctx) => ctx.db.query("providerConnections").collect());
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ provider: "google", status: "connected", credentials });
  });

  test("imports raw wiki material as sources, not searchable pages", async () => {
    const { t, client } = await owner();
    const payload = emptyPayload();
    payload.wikiSources.push({ title: "private-session", origin: "raw/sessions/session.md", extractedText: "private raw interaction", createdAt: 100, updatedAt: 200 });
    await client.mutation(api.legacyImport.applyBatch, payload);
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    const stored = await t.run(async (ctx) => {
      const pages = await ctx.db.query("wikiPages").collect();
      const searchDocuments = await ctx.db.query("wikiSearchDocuments").collect();
      const sources = await ctx.db.query("wikiSources").collect();
      const chunks = await ctx.db.query("wikiChunks").collect();
      return { pages, searchDocuments, sources, chunks };
    });
    expect(stored.pages).toHaveLength(0);
    expect(stored.searchDocuments).toHaveLength(0);
    expect(stored.sources).toHaveLength(1);
    expect(stored.sources[0].status).toBe("indexed");
    await t.mutation(internal.wiki.indexSource, { sourceId: stored.sources[0]._id });
    const sourceChunks = await t.run(async (ctx) => ctx.db.query("wikiChunks").collect());
    expect(sourceChunks.some((chunk) => chunk.sourceId === stored.sources[0]._id)).toBe(true);
  });
});
