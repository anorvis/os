/**
 * SnapTrade Personal read-only integration. Security posture: do not weaken
 * without re-review.
 *
 * Personal requests send only clientId and timestamp in the query; consumerKey
 * remains the HMAC signing key and is never transmitted. userId/userSecret are
 * intentionally omitted. The generated SDK transport is not used because its
 * stale Personal contract requires those fields, but official SDK response
 * models still define this provider boundary. The connection portal is locked
 * to read access; this module exposes no trading, transfer, or money-movement
 * endpoint. Provider DTOs are normalized before canonical Finance persistence.
 */
import { createHmac } from "node:crypto";
import type {
  Account as SnapTradeAccount,
  AccountPosition as SnapTradePosition,
  AccountUniversalActivity as SnapTradeActivity,
  AccountValueHistoryResponse,
  AllAccountPositionsResponse,
  Balance as SnapTradeBalance,
  PaginatedUniversalActivity,
  RateOfReturnResponse,
} from "snaptrade-typescript-sdk";
import {
  autoLinkFinanceAccount,
  createImportBatch,
  deleteFinanceActivity,
  finalizeImportBatch,
  slugifyName,
  upsertFinanceAccount,
  upsertFinanceAccountHistory,
  upsertFinanceAccountReturnRate,
  upsertFinanceActivity,
  upsertFinanceBalance,
  upsertFinanceTransaction,
  upsertFinancePosition,
} from "./data";
import type { FinanceAccountType } from "./schema";
import {
  disconnectProvider,
  getProviderConnectionState,
  getProviderDefinition,
  getProviderSecret,
  saveProviderConnection,
} from "../integration/providers";

const PROVIDER_ID = "snaptrade";
const SOURCE = "snaptrade";
const BASE_URL = "https://api.snaptrade.com";
const API_PREFIX = "/api/v1";
const CONNECTION_TYPE_READ = "read";
const CONNECTION_PORTAL_VERSION = "v4";
const ACTIVITIES_PAGE_LIMIT = 1000;
// Defensive ceiling: at 1000 activities/page this is a million rows per account,
// well past any real brokerage history, but stops a malformed pagination cursor
// from looping forever.
const ACTIVITIES_MAX_PAGES = 1000;

// --- Injectable transport ----------------------------------------------------
// Tests inject a fetch double to assert the signed URL/headers/body and to feed
// canned responses without network access. Production uses the global fetch.

export type SnapTradeFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

const defaultTransport: SnapTradeFetch = (url, init) => fetch(url, init);
let transport: SnapTradeFetch = defaultTransport;

export function setSnapTradeFetch(next: SnapTradeFetch | null): void {
  transport = next ?? defaultTransport;
}

// --- Errors ------------------------------------------------------------------

export class SnapTradeError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  constructor(
    message: string,
    options: { status?: number | null; code?: string | null } = {},
  ) {
    super(message);
    this.name = "SnapTradeError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

// --- Public settings ---------------------------------------------------------

export type SnapTradeSettings = {
  connected: boolean;
  hasClientId: boolean;
  hasConsumerKey: boolean;
  status: string;
  secretProvider: string | null;
  lastCheckedAt: string | null;
};

export function getSnapTradeSettings(): SnapTradeSettings {
  const definition = getProviderDefinition(PROVIDER_ID);
  const connection = getProviderConnectionState(PROVIDER_ID);
  const hasClientId = Boolean(getProviderSecret(PROVIDER_ID, "clientId"));
  const hasConsumerKey = Boolean(getProviderSecret(PROVIDER_ID, "consumerKey"));
  const settings =
    asRecord(safeJsonParse(connection?.settingsJson ?? "{}")) ?? {};
  return {
    connected:
      definition?.status === "connected" && hasClientId && hasConsumerKey,
    hasClientId,
    hasConsumerKey,
    status: definition?.status ?? "available",
    secretProvider: definition?.secretProvider ?? null,
    lastCheckedAt:
      stringValue(settings.lastCheckedAt) ?? connection?.updatedAt ?? null,
  };
}

export function saveSnapTradeSettings(
  input: unknown,
  now = new Date(),
): SnapTradeSettings {
  const record = asRecord(input);
  const clientId = trimmedString(record?.clientId);
  const consumerKey = trimmedString(record?.consumerKey);
  if (!clientId || !consumerKey) {
    throw new SnapTradeError("clientId and consumerKey are required", {
      code: "invalid_settings",
    });
  }
  // clientId + consumerKey are both stored as named secrets so neither value is
  // ever returned to callers; the settings response only exposes booleans.
  saveProviderConnection(
    PROVIDER_ID,
    {
      settings: { configured: true, lastCheckedAt: now.toISOString() },
      secrets: { clientId, consumerKey },
    },
    "connected",
    now,
  );
  return getSnapTradeSettings();
}

export function disconnectSnapTrade(now = new Date()): { ok: true } {
  // Local-only: clears the stored clientId/consumerKey and resets connection
  // state. Deliberately does NOT call any upstream endpoint, so the user's
  // brokerage connections at SnapTrade are left intact.
  disconnectProvider(PROVIDER_ID, now);
  return { ok: true };
}

// --- Connection portal (read-only) -------------------------------------------

export type SnapTradeConnectionPortal = {
  redirectUri: string;
  sessionId: string | null;
};

export async function createSnapTradeConnectionPortal(
  input: unknown,
  now = new Date(),
): Promise<SnapTradeConnectionPortal> {
  const credentials = requireCredentials();
  const options = parsePortalOptions(input);
  const body: Record<string, unknown> = {
    // Hardcoded read-only connection. This is the single source of truth for the
    // portal's capability and cannot be overridden by the caller.
    connectionType: CONNECTION_TYPE_READ,
    showCloseButton: true,
    connectionPortalVersion: CONNECTION_PORTAL_VERSION,
  };
  if (options.broker) body.broker = options.broker;
  if (options.customRedirect) body.customRedirect = options.customRedirect;
  if (options.reconnect) body.reconnect = options.reconnect;
  if (options.immediateRedirect !== undefined)
    body.immediateRedirect = options.immediateRedirect;

  const payload = await request<unknown>({
    method: "POST",
    path: "/snapTrade/login",
    body,
    credentials,
    now,
  });
  const record = asRecord(payload);
  const redirectUri = stringValue(record?.redirectURI);
  if (!redirectUri) {
    throw new SnapTradeError(
      "SnapTrade did not return a connection portal URL",
      {
        code: "portal_no_url",
      },
    );
  }
  return { redirectUri, sessionId: stringValue(record?.sessionId) };
}

type PortalOptions = {
  broker?: string;
  customRedirect?: string;
  reconnect?: string;
  immediateRedirect?: boolean;
};

function parsePortalOptions(input: unknown): PortalOptions {
  const record = asRecord(input) ?? {};
  // Reject any request to change the connection type. The portal is read-only.
  if ("connectionType" in record) {
    const requested = trimmedString(record.connectionType);
    if (requested && requested.toLowerCase() !== CONNECTION_TYPE_READ) {
      throw new SnapTradeError(
        "connectionType is locked to 'read' for this integration",
        {
          code: "connection_type_locked",
        },
      );
    }
  }
  const options: PortalOptions = {};
  const broker = trimmedString(record.broker);
  if (broker) options.broker = broker;
  const reconnect = trimmedString(record.reconnect);
  if (reconnect) options.reconnect = reconnect;
  const customRedirect = safeRedirect(record.customRedirect);
  if (customRedirect) options.customRedirect = customRedirect;
  if (typeof record.immediateRedirect === "boolean")
    options.immediateRedirect = record.immediateRedirect;
  return options;
}

function safeRedirect(value: unknown): string | undefined {
  const raw = trimmedString(value);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SnapTradeError("customRedirect must be an absolute http(s) URL", {
      code: "invalid_redirect",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SnapTradeError(
      "customRedirect must use the http or https scheme",
      {
        code: "invalid_redirect",
      },
    );
  }
  return url.toString();
}

// --- Sync --------------------------------------------------------------------

export type SnapTradeSyncResult = {
  ok: true;
  accounts: number;
  balances: number;
  positions: number;
  activities: number;
  activitiesInserted: number;
  activitiesSkipped: number;
  transactions: number;
  transactionsInserted: number;
  transactionsSkipped: number;
  accountsLinked: number;
  historyPoints: number;
  returnRates: number;
  warnings: string[];
};

export async function syncSnapTrade(
  now = new Date(),
): Promise<SnapTradeSyncResult> {
  const credentials = requireCredentials();
  const observedAt = now.toISOString();
  const importId = createImportBatch(
    { source: SOURCE, status: "running" },
    now,
  );
  const counts = {
    accounts: 0,
    balances: 0,
    positions: 0,
    activities: 0,
    inserted: 0,
    transactions: 0,
    transactionsInserted: 0,
    transactionsSkipped: 0,
    accountsLinked: 0,
  };
  const dedupe = { claimed: new Set<string>() };
  const warnings: string[] = [];
  let historyPoints = 0;
  let returnRates = 0;
  try {
    for (const rawAccount of await fetchAccounts(credentials, now)) {
      const account = normalizeAccount(rawAccount);
      if (!account) continue;
      const accountId = upsertFinanceAccount(
        {
          source: SOURCE,
          sourceId: account.sourceId,
          sourceVariant: account.institutionSlug,
          name: account.name,
          type: account.type,
          currency: account.currency,
          balance: account.balance,
          institution: account.institution,
          mask: account.mask,
          status: account.status,
          importId,
          observedAt,
        },
        now,
      );
      counts.accounts += 1;
      const link = autoLinkFinanceAccount(accountId, now);
      if (link.status === "linked") counts.accountsLinked += 1;
      if (link.status === "ambiguous") {
        warnings.push(
          `${account.name}: multiple accounts match its identity; leaving unlinked`,
        );
      }

      let accountCash = 0;
      let hasAccountCash = false;
      for (const rawBalance of await fetchBalances(
        credentials,
        account.sourceId,
        now,
      )) {
        const balance = normalizeBalance(rawBalance, account.currency);
        if (!balance) continue;
        if (balance.cash !== null && balance.currency === account.currency) {
          accountCash += balance.cash;
          hasAccountCash = true;
        }
        upsertFinanceBalance(
          {
            accountId,
            currency: balance.currency,
            cash: balance.cash,
            buyingPower: balance.buyingPower,
            source: SOURCE,
            sourceVariant: account.institutionSlug,
            importId,
            observedAt,
          },
          now,
        );
        counts.balances += 1;
      }

      const accountHistory = await fetchOptionalAccountHistory(
        credentials,
        account.sourceId,
        now,
      );
      if (accountHistory === null) {
        warnings.push(`${account.name}: balance history is unavailable`);
      } else {
        for (const point of normalizeAccountHistory(
          accountHistory,
          account.currency,
        )) {
          upsertFinanceAccountHistory(
            {
              accountId,
              source: SOURCE,
              sourceVariant: account.institutionSlug,
              date: point.date,
              equity: point.equity,
              cash: null,
              currency: point.currency,
              importId,
              observedAt,
            },
            now,
          );
          historyPoints += 1;
        }
      }
      if (account.balance !== null) {
        upsertFinanceAccountHistory(
          {
            accountId,
            source: SOURCE,
            sourceVariant: account.institutionSlug,
            date: observedAt.slice(0, 10),
            equity: account.balance,
            cash: hasAccountCash ? accountCash : null,
            currency: account.currency,
            importId,
            observedAt,
          },
          now,
        );
        historyPoints += 1;
      }

      const accountReturnRates = await fetchOptionalAccountReturnRates(
        credentials,
        account.sourceId,
        now,
      );
      if (accountReturnRates === null) {
        warnings.push(`${account.name}: return rates are unavailable`);
      } else {
        for (const rate of normalizeAccountReturnRates(accountReturnRates)) {
          upsertFinanceAccountReturnRate(
            {
              accountId,
              source: SOURCE,
              sourceVariant: account.institutionSlug,
              timeframe: rate.timeframe,
              returnPercent: rate.returnPercent,
              asOf: rate.asOf,
              importId,
              observedAt,
            },
            now,
          );
          returnRates += 1;
        }
      }

      for (const rawPosition of await fetchPositions(
        credentials,
        account.sourceId,
        now,
      )) {
        const position = normalizePosition(rawPosition, account.currency);
        if (!position) continue;
        upsertFinancePosition(
          {
            accountId,
            source: SOURCE,
            sourceId: position.sourceId,
            sourceVariant: account.institutionSlug,
            symbol: position.symbol,
            name: position.name,
            quantity: position.quantity,
            marketValue: position.marketValue,
            averageCost: position.averageCost,
            currency: position.currency,
            importId,
            observedAt,
          },
          now,
        );
        counts.positions += 1;
      }

      for (
        let offset = 0, page = 0;
        page < ACTIVITIES_MAX_PAGES;
        offset += ACTIVITIES_PAGE_LIMIT, page += 1
      ) {
        const activities = await fetchActivities(
          credentials,
          account.sourceId,
          offset,
          now,
        );
        for (const rawActivity of activities.data) {
          const activity = normalizeActivity(rawActivity, account.currency);
          if (!activity) continue;
          if (isPromotableSpend(account, activity)) {
            const result = upsertFinanceTransaction(
              {
                accountId,
                source: SOURCE,
                sourceId: activity.sourceId ?? null,
                sourceVariant: account.institutionSlug,
                fingerprint: activity.fingerprint,
                description: cardSpendDescription(activity),
                amount: -activity.amount,
                currency: activity.currency,
                postedAt: activity.occurredAt,
                category: "card spend",
                status: "posted",
                importId,
              },
              now,
              dedupe,
            );
            counts.transactions += 1;
            if (result.inserted) counts.transactionsInserted += 1;
            else counts.transactionsSkipped += 1;
            deleteFinanceActivity(SOURCE, activity.fingerprint);
          } else {
            const result = upsertFinanceActivity(
              {
                accountId,
                source: SOURCE,
                sourceId: activity.sourceId,
                sourceVariant: account.institutionSlug,
                type: activity.type,
                description: activity.description,
                amount: activity.amount,
                currency: activity.currency,
                symbol: activity.symbol,
                quantity: activity.quantity,
                price: activity.price,
                fingerprint: activity.fingerprint,
                occurredAt: activity.occurredAt,
                settledAt: activity.settledAt,
                importId,
              },
              now,
            );
            counts.activities += 1;
            if (result.inserted) counts.inserted += 1;
          }
        }
        if (activities.data.length < ACTIVITIES_PAGE_LIMIT) break;
        if (
          activities.total !== null &&
          offset + ACTIVITIES_PAGE_LIMIT >= activities.total
        )
          break;
      }
    }

    const activitiesSkipped = counts.activities - counts.inserted;
    finalizeImportBatch(
      importId,
      {
        status: "completed",
        imported:
          counts.accounts +
          counts.balances +
          counts.positions +
          counts.inserted +
          counts.transactionsInserted +
          historyPoints +
          returnRates,
        skipped: activitiesSkipped + counts.transactionsSkipped,
      },
      now,
    );
    // Refresh lastChecked after a successful authenticated sync. Passing no
    // secrets merges settings while leaving the stored credentials intact.
    saveProviderConnection(
      PROVIDER_ID,
      { settings: { lastCheckedAt: now.toISOString() } },
      "connected",
      now,
    );
    return {
      ok: true,
      accounts: counts.accounts,
      balances: counts.balances,
      positions: counts.positions,
      activities: counts.activities,
      activitiesInserted: counts.inserted,
      activitiesSkipped,
      transactions: counts.transactions,
      transactionsInserted: counts.transactionsInserted,
      transactionsSkipped: counts.transactionsSkipped,
      accountsLinked: counts.accountsLinked,
      historyPoints,
      returnRates,
      warnings,
    };
  } catch (error) {
    finalizeImportBatch(
      importId,
      {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
      now,
    );
    throw error;
  }
}

// --- Upstream reads (no trading endpoints) -----------------------------------

async function fetchAccounts(
  credentials: SnapTradeCredentials,
  now: Date,
): Promise<SnapTradeAccount[]> {
  const payload = await request<SnapTradeAccount[]>({
    method: "GET",
    path: "/accounts",
    credentials,
    now,
  });
  return typedArray<SnapTradeAccount>(payload);
}

async function fetchBalances(
  credentials: SnapTradeCredentials,
  accountId: string,
  now: Date,
): Promise<SnapTradeBalance[]> {
  const payload = await request<SnapTradeBalance[]>({
    method: "GET",
    path: `/accounts/${encodeURIComponent(accountId)}/balances`,
    credentials,
    now,
  });
  return typedArray<SnapTradeBalance>(payload);
}

async function fetchPositions(
  credentials: SnapTradeCredentials,
  accountId: string,
  now: Date,
): Promise<SnapTradePosition[]> {
  const payload = await request<AllAccountPositionsResponse>({
    method: "GET",
    path: `/accounts/${encodeURIComponent(accountId)}/positions/all`,
    credentials,
    now,
  });
  return typedArray<SnapTradePosition>(payload.results);
}

async function fetchActivities(
  credentials: SnapTradeCredentials,
  accountId: string,
  offset: number,
  now: Date,
): Promise<{ data: SnapTradeActivity[]; total: number | null }> {
  const payload = await request<PaginatedUniversalActivity>({
    method: "GET",
    path: `/accounts/${encodeURIComponent(accountId)}/activities`,
    query: { offset: String(offset), limit: String(ACTIVITIES_PAGE_LIMIT) },
    credentials,
    now,
  });
  const pagination = asRecord(payload.pagination);
  const total =
    pagination && typeof pagination.total === "number"
      ? pagination.total
      : null;
  return { data: typedArray<SnapTradeActivity>(payload.data), total };
}

async function fetchOptionalAccountHistory(
  credentials: SnapTradeCredentials,
  accountId: string,
  now: Date,
): Promise<AccountValueHistoryResponse | null> {
  try {
    return await request<AccountValueHistoryResponse>({
      method: "GET",
      path: `/accounts/${encodeURIComponent(accountId)}/balanceHistory`,
      credentials,
      now,
    });
  } catch (error) {
    if (isOptionalFeatureUnavailable(error)) return null;
    throw error;
  }
}

async function fetchOptionalAccountReturnRates(
  credentials: SnapTradeCredentials,
  accountId: string,
  now: Date,
): Promise<RateOfReturnResponse | null> {
  try {
    return await request<RateOfReturnResponse>({
      method: "GET",
      path: `/accounts/${encodeURIComponent(accountId)}/returnRates`,
      credentials,
      now,
    });
  } catch (error) {
    if (isOptionalFeatureUnavailable(error)) return null;
    throw error;
  }
}

function isOptionalFeatureUnavailable(error: unknown): boolean {
  return (
    error instanceof SnapTradeError &&
    (error.status === 403 || error.status === 404)
  );
}

// --- Signed request ----------------------------------------------------------

type SnapTradeCredentials = { clientId: string; consumerKey: string };

type RequestOptions = {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  credentials: SnapTradeCredentials;
  now: Date;
};

async function request<T>(options: RequestOptions): Promise<T> {
  const { url, init } = buildSignedRequest(options);
  let response: Response;
  try {
    response = await transport(url, init);
  } catch (error) {
    throw new SnapTradeError(
      `SnapTrade request failed: ${error instanceof Error ? error.message : String(error)}`,
      { code: "transport" },
    );
  }
  const text = await response.text().catch(() => "");
  const payload = safeJsonParse(text);
  if (!response.ok) {
    throw new SnapTradeError(upstreamMessage(response.status, payload, text), {
      status: response.status,
      code: extractUpstreamCode(payload),
    });
  }
  return payload as T;
}

function buildSignedRequest(options: RequestOptions): {
  url: string;
  init: RequestInit;
} {
  const fullPath = `${API_PREFIX}${options.path}`;
  const timestamp = Math.floor(options.now.getTime() / 1000);
  const params = new URLSearchParams();
  params.set("clientId", options.credentials.clientId);
  params.set("timestamp", String(timestamp));
  for (const [key, value] of Object.entries(options.query ?? {}))
    params.set(key, value);
  // The exact query bytes sent on the wire are the exact bytes that get signed.
  const query = params.toString();
  // GET requests sign a null content, matching the server side.
  const content = options.body === undefined ? null : options.body;
  const signature = snapTradeSignature({
    content,
    path: fullPath,
    query,
    consumerKey: options.credentials.consumerKey,
  });
  const headers: Record<string, string> = {
    Accept: "application/json",
    Signature: signature,
  };
  const init: RequestInit = { method: options.method, headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    // Send canonical bytes; the server re-parses and re-canonicalizes content,
    // so structure (not formatting) is what must match the signature.
    init.body = canonicalJson(options.body);
  }
  return { url: `${BASE_URL}${fullPath}?${query}`, init };
}

// base64( HMAC-SHA256( consumerKey, canonicalJson({content, path, query}) ) ).
// The consumerKey is the HMAC key only and never leaves this process.
export function snapTradeSignature(input: {
  content: unknown;
  path: string;
  query: string;
  consumerKey: string;
}): string {
  const sigContent = canonicalJson({
    content: input.content,
    path: input.path,
    query: input.query,
  });
  return createHmac("sha256", input.consumerKey)
    .update(sigContent, "utf8")
    .digest("base64");
}

// Deterministic JSON identical to Python's
// json.dumps(value, separators=(",", ":"), sort_keys=True) (ensure_ascii=True),
// which is what SnapTrade uses to reconstruct the signed content server-side.
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return encodeJsonString(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      parts.push(`${encodeJsonString(key)}:${canonicalJson(record[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  return "null";
}

function encodeJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    switch (code) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      default:
        // ensure_ascii: escape controls and everything outside printable ASCII.
        out +=
          code < 0x20 || code > 0x7e
            ? `\\u${code.toString(16).padStart(4, "0")}`
            : value[i];
    }
  }
  return `${out}"`;
}

// --- Normalization (SnapTrade DTO -> provider-neutral canonical inputs) -------

type NormalizedHistoryPoint = {
  date: string;
  equity: number;
  currency: string;
};

function normalizeAccountHistory(
  payload: AccountValueHistoryResponse,
  fallbackCurrency: string,
): NormalizedHistoryPoint[] {
  const currency =
    normalizeCurrency(stringValue(payload.currency)) ??
    normalizeCurrency(fallbackCurrency);
  if (!currency) return [];
  const points: NormalizedHistoryPoint[] = [];
  for (const raw of typedArray<unknown>(payload.history)) {
    const record = asRecord(raw);
    const date = stringValue(record?.date);
    const equity = toNumber(record?.total_value);
    if (!date || equity === null) continue;
    points.push({ date, equity, currency });
  }
  return points;
}

type NormalizedReturnRate = {
  timeframe: string;
  returnPercent: number;
  asOf: string | null;
};

function normalizeAccountReturnRates(
  payload: RateOfReturnResponse,
): NormalizedReturnRate[] {
  const rates: NormalizedReturnRate[] = [];
  for (const raw of typedArray<unknown>(payload.data)) {
    const record = asRecord(raw);
    const timeframe = stringValue(record?.timeframe)?.toUpperCase();
    const returnPercent = toNumber(record?.return_percent);
    if (!timeframe || returnPercent === null) continue;
    rates.push({
      timeframe,
      returnPercent,
      asOf: stringValue(record?.created_date),
    });
  }
  return rates;
}

type NormalizedAccount = {
  sourceId: string;
  name: string;
  type: FinanceAccountType;
  currency: string;
  balance: number | null;
  institution: string | null;
  institutionSlug: string | null;
  mask: string | null;
  status: string | undefined;
};

function normalizeAccount(raw: SnapTradeAccount): NormalizedAccount | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sourceId = stringValue(record.id);
  if (!sourceId) return null;
  const total = asRecord(asRecord(record.balance)?.total);
  const currency = normalizeCurrency(stringValue(total?.currency));
  if (!currency) return null;
  const institution = stringValue(record.institution_name);
  const number = stringValue(record.number);
  return {
    sourceId,
    name: stringValue(record.name) ?? institution ?? "SnapTrade account",
    type: mapAccountType(record.account_category, record.raw_type, record.name),
    currency,
    balance: toNumber(total?.amount),
    institution,
    institutionSlug: institution ? slugifyName(institution) : null,
    mask: maskFromNumber(number),
    status: stringValue(record.status)?.toLowerCase() ?? undefined,
  };
}

function mapAccountType(
  category: unknown,
  rawType: unknown,
  name: unknown,
): FinanceAccountType {
  switch (stringValue(category)?.toUpperCase()) {
    case "DEPOSIT":
      return "checking";
    case "LOC":
      return "credit";
    case "INVESTMENT":
      return "investment";
  }

  const hint = [stringValue(rawType), stringValue(name)]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toUpperCase();
  if (/\b(SAVINGS?|HISA)\b/.test(hint)) return "savings";
  if (/\b(MSB|CHEQUING|CHECKING)\b/.test(hint)) return "checking";
  if (/\bLOC\b/.test(hint)) return "credit";
  if (/\bCRYPTO\b/.test(hint)) return "crypto";

  // SnapTrade is brokerage-first; genuinely unknown accounts remain investment
  // accounts rather than being guessed from balances or current holdings.
  return "investment";
}

type NormalizedBalance = {
  currency: string;
  cash: number | null;
  buyingPower: number | null;
};

function normalizeBalance(
  raw: SnapTradeBalance,
  fallbackCurrency: string,
): NormalizedBalance | null {
  const record = asRecord(raw);
  if (!record) return null;
  const currency =
    normalizeCurrency(stringValue(asRecord(record.currency)?.code)) ??
    normalizeCurrency(fallbackCurrency);
  if (!currency) return null;
  return {
    currency,
    cash: toNumber(record.cash),
    buyingPower: toNumber(record.buying_power),
  };
}

type NormalizedPosition = {
  sourceId: string | undefined;
  symbol: string;
  name: string | null;
  currency: string;
  quantity: number;
  marketValue: number | null;
  averageCost: number | null;
};

function normalizePosition(
  raw: SnapTradePosition,
  fallbackCurrency: string,
): NormalizedPosition | null {
  const record = asRecord(raw);
  if (!record) return null;
  const instrument = asRecord(record.instrument);
  const symbol = stringValue(instrument?.symbol);
  if (!symbol) return null;
  const quantity = toNumber(record.units);
  if (quantity === null) return null;
  const currency =
    normalizeCurrency(stringValue(instrument?.currency)) ??
    normalizeCurrency(stringValue(record.currency)) ??
    normalizeCurrency(fallbackCurrency);
  if (!currency) return null;
  const price = toNumber(record.price);
  return {
    sourceId: stringValue(instrument?.id) ?? undefined,
    symbol,
    name: stringValue(instrument?.description),
    currency,
    quantity,
    // marketValue is not returned by positions/all; derive it from units * price.
    marketValue: price !== null ? roundTo(quantity * price, 8) : null,
    // cost_basis is the per-share average cost (confirmed against SnapTrade docs).
    averageCost: toNumber(record.cost_basis),
  };
}

type NormalizedActivity = {
  sourceId: string | undefined;
  type: string;
  description: string | null;
  amount: number | null;
  currency: string;
  symbol: string | undefined;
  quantity: number | null;
  price: number | null;
  fingerprint: string;
  occurredAt: string;
  settledAt: string | undefined;
};

function isPromotableSpend(
  account: NormalizedAccount,
  activity: NormalizedActivity,
): activity is NormalizedActivity & { amount: number } {
  if (account.type !== "checking" && account.type !== "savings") return false;
  if (activity.type !== "spend") return false;
  if (
    activity.amount === null ||
    !Number.isFinite(activity.amount) ||
    activity.amount === 0
  )
    return false;
  if (
    activity.symbol !== undefined ||
    activity.quantity !== null ||
    activity.price !== null
  )
    return false;
  return true;
}

function normalizeActivity(
  raw: SnapTradeActivity,
  fallbackCurrency: string,
): NormalizedActivity | null {
  const record = asRecord(raw);
  if (!record) return null;
  const currency = resolveActivityCurrency(record, fallbackCurrency);
  if (!currency) return null;
  const occurredAt =
    isoDate(stringValue(record.trade_date)) ??
    isoDate(stringValue(record.settlement_date));
  if (!occurredAt) return null;
  const sourceId = stringValue(record.id);
  const symbol = resolveActivitySymbol(record);
  return {
    sourceId: sourceId ?? undefined,
    type: stringValue(record.type)?.toLowerCase() ?? "other",
    description: stringValue(record.description),
    amount: toNumber(record.amount),
    currency,
    symbol,
    quantity: nullableZeroAmount(record.units, symbol),
    price: nullableZeroAmount(record.price, symbol),
    // The SnapTrade activity id is globally unique and stable, giving idempotent
    // upserts via UNIQUE(source, fingerprint). Fall back to a stable content hash
    // only when an id is somehow absent.
    fingerprint: sourceId ?? compositeFingerprint(record, occurredAt),
    occurredAt,
    settledAt: isoDate(stringValue(record.settlement_date)) ?? undefined,
  };
}

function nullableZeroAmount(
  value: unknown,
  symbol: string | undefined,
): number | null {
  const amount = toNumber(value);
  if (amount === 0 && symbol === undefined) return null;
  return amount;
}

function cardSpendDescription(
  activity: NormalizedActivity & { amount: number },
): string {
  const description = activity.description?.trim();
  if (description && description.toLowerCase() !== "spend") return description;
  return activity.amount < 0 ? "Card refund" : "Card purchase";
}

function resolveActivityCurrency(
  record: Record<string, unknown>,
  fallback: string,
): string | null {
  const direct = normalizeCurrency(
    stringValue(asRecord(record.currency)?.code),
  );
  if (direct) return direct;
  // Crypto activity may be denominated in a security rather than a fiat currency.
  const universal = normalizeCurrency(
    stringValue(asRecord(record.currency_universal_symbol)?.symbol),
  );
  if (universal) return universal;
  return normalizeCurrency(fallback);
}

function resolveActivitySymbol(
  record: Record<string, unknown>,
): string | undefined {
  const equity = stringValue(asRecord(record.symbol)?.symbol);
  if (equity) return equity;
  const option = asRecord(record.option_symbol);
  const optionTicker =
    stringValue(option?.ticker) ??
    stringValue(asRecord(option?.underlying_symbol)?.symbol);
  if (optionTicker) return optionTicker;
  return (
    stringValue(asRecord(record.currency_universal_symbol)?.symbol) ?? undefined
  );
}

function compositeFingerprint(
  record: Record<string, unknown>,
  occurredAt: string,
): string {
  const parts = [
    stringValue(record.type) ?? "",
    occurredAt,
    String(toNumber(record.units) ?? ""),
    String(toNumber(record.price) ?? ""),
    String(toNumber(record.amount) ?? ""),
    resolveActivitySymbol(record) ?? "",
    stringValue(record.description) ?? "",
  ].join("|");
  return `snaptrade:activity:${createHmac("sha256", SOURCE).update(parts, "utf8").digest("hex")}`;
}

// --- Credentials + connection state ------------------------------------------

function requireCredentials(): SnapTradeCredentials {
  const clientId = getProviderSecret(PROVIDER_ID, "clientId");
  const consumerKey = getProviderSecret(PROVIDER_ID, "consumerKey");
  if (!clientId || !consumerKey) {
    throw new SnapTradeError(
      "SnapTrade is not connected: save clientId and consumerKey first",
      {
        code: "not_connected",
      },
    );
  }
  return { clientId, consumerKey };
}

// --- Parsing helpers ---------------------------------------------------------

function upstreamMessage(
  status: number,
  payload: unknown,
  rawText: string,
): string {
  const record = asRecord(payload);
  const detail =
    stringValue(record?.detail) ??
    stringValue(record?.message) ??
    stringValue(record?.description) ??
    (rawText.trim() ? rawText.trim().slice(0, 300) : null);
  return detail
    ? `SnapTrade request failed (${status}): ${detail}`
    : `SnapTrade request failed with status ${status}`;
}

function extractUpstreamCode(payload: unknown): string | null {
  const record = asRecord(payload);
  const code = record?.code;
  if (typeof code === "string" && code) return code;
  if (typeof code === "number") return String(code);
  return null;
}

function safeJsonParse(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function typedArray<T>(value: unknown): T[] {
  return asArray(value) as T[];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Parses SnapTrade decimals, which arrive as either numbers or precision-safe
// strings, into finite numbers; anything else becomes null.
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeCurrency(value: unknown): string | null {
  const code = trimmedString(value)?.toUpperCase();
  return code && /^[A-Z]{3,5}$/.test(code) ? code : null;
}

function maskFromNumber(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/[^A-Za-z0-9]/g, "");
  return digits ? digits.slice(-4) : null;
}

function isoDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
