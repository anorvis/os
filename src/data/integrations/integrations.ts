import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/database";
import { deleteSecret, describeSecretProvider, getSecret, setSecret } from "../shared/secrets";

export type IntegrationCatalogEntry = {
  id: string;
  displayName: string;
  category: "life" | "library" | "productivity" | "health";
  description: string;
  capabilities: string[];
  authType: "local" | "oauth2" | "token" | "webhook";
  status: "connected" | "pending" | "available" | "unavailable";
  connectProvider?: string;
  setupHint?: string;
};

type IntegrationRow = {
  id: string;
  display_name: string;
  category: IntegrationCatalogEntry["category"];
  description: string;
  capabilities_json: string;
  auth_type: IntegrationCatalogEntry["authType"];
  status: IntegrationCatalogEntry["status"] | null;
};

export function listIntegrations(): { integrations: IntegrationCatalogEntry[] } {
  const integrations = getDatabase().query<IntegrationRow, []>(`
    SELECT catalog.id, catalog.display_name, catalog.category, catalog.description, catalog.capabilities_json, catalog.auth_type, connections.status
    FROM integration_catalog catalog
    LEFT JOIN integration_connections connections ON connections.integration_id = catalog.id
    ORDER BY catalog.category ASC, catalog.display_name ASC
  `).all().map(rowToIntegration);
  return { integrations };
}

export type HevySettings = {
  connected: boolean;
  hasApiKey: boolean;
  lastCheckedAt: string | null;
  secretProvider: string | null;
};

export type IntegrationForbidden = {
  ok: false;
  error: "integration not connected";
  code: "integration_not_connected";
  provider: "hevy";
};

export type HevySyncResult = { ok: true; fetched: number; created: number; updated: number } | IntegrationForbidden;

export function getHevySettings(): HevySettings {
  const row = getDatabase().query<{ status: string; secret_ref: string | null; updated_at: string }, []>("SELECT status, secret_ref, updated_at FROM integration_connections WHERE integration_id = 'hevy'").get();
  return {
    connected: row?.status === "connected",
    hasApiKey: Boolean(row?.secret_ref),
    lastCheckedAt: row?.updated_at ?? null,
    secretProvider: describeSecretProvider(row?.secret_ref) ?? null,
  };
}

export function saveHevySettings(input: { apiKey: string }, now = new Date()): HevySettings & { ok: true; status: "connected" } {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("apiKey is required");
  const secretRef = setSecret("hevy-api-key", apiKey, now);
  const timestamp = now.toISOString();
  getDatabase().query(`
    INSERT INTO integration_connections (id, integration_id, status, settings_json, secret_ref, connected_at, updated_at)
    VALUES (?1, 'hevy', 'connected', ?2, ?3, ?4, ?4)
    ON CONFLICT(integration_id) DO UPDATE SET status = 'connected', settings_json = excluded.settings_json, secret_ref = excluded.secret_ref, connected_at = COALESCE(integration_connections.connected_at, excluded.connected_at), updated_at = excluded.updated_at
  `).run(randomUUID(), JSON.stringify({ configured: true }), secretRef, timestamp);
  return { ...getHevySettings(), ok: true, status: "connected" };
}

export function disconnectHevy(now = new Date()): { ok: true } {
  const row = getDatabase().query<{ secret_ref: string | null }, []>("SELECT secret_ref FROM integration_connections WHERE integration_id = 'hevy'").get();
  deleteSecret(row?.secret_ref);
  getDatabase().query("UPDATE integration_connections SET status = 'available', secret_ref = NULL, settings_json = NULL, updated_at = ?1 WHERE integration_id = 'hevy'").run(now.toISOString());
  return { ok: true };
}

export function syncHevy(): HevySyncResult {
  const row = getDatabase().query<{ secret_ref: string | null }, []>("SELECT secret_ref FROM integration_connections WHERE integration_id = 'hevy'").get();
  let apiKey: string | null = null;
  try {
    apiKey = getSecret(row?.secret_ref);
  } catch {
    apiKey = null;
  }
  if (!apiKey) return { ok: false, error: "integration not connected", code: "integration_not_connected", provider: "hevy" };
  return { ok: true, fetched: 0, created: 0, updated: 0 };
}

export function parseHevySettings(value: unknown): { apiKey: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("apiKey" in value) || typeof value.apiKey !== "string") return null;
  const apiKey = value.apiKey.trim();
  return apiKey ? { apiKey } : null;
}

function rowToIntegration(row: IntegrationRow): IntegrationCatalogEntry {
  return {
    id: row.id,
    displayName: row.display_name,
    category: row.category,
    description: row.description,
    capabilities: parseCapabilities(row.capabilities_json),
    authType: row.auth_type,
    status: row.status ?? "available",
    connectProvider: row.auth_type === "oauth2" ? row.id : undefined,
    setupHint: row.auth_type === "token" ? "Add a local API token." : undefined,
  };
}

function parseCapabilities(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
