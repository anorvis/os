import { connectProvider, disconnectProvider, getProviderConnectionState, getProviderDefinition, getProviderSecret, listProviders, type ProviderDefinition } from "./providers";
import { getGoogleSettings, saveGoogleSettings } from "./google";

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

export function listIntegrations(): { integrations: IntegrationCatalogEntry[] } {
  return { integrations: listProviders().providers.map(providerToIntegration) };
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
  const provider = getProviderDefinition("hevy");
  const connection = getProviderConnectionState("hevy");
  return {
    connected: provider?.status === "connected",
    hasApiKey: Boolean(provider?.secretProvider),
    lastCheckedAt: connection?.updatedAt ?? null,
    secretProvider: provider?.secretProvider ?? null,
  };
}

export function saveHevySettings(input: { apiKey: string }, now = new Date()): HevySettings & { ok: true; status: "connected" } {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("apiKey is required");
  connectProvider("hevy", { settings: { configured: true }, secrets: { token: apiKey } }, now);
  return { ...getHevySettings(), ok: true, status: "connected" };
}

export function disconnectHevy(now = new Date()): { ok: true } {
  disconnectProvider("hevy", now);
  return { ok: true };
}

export function syncHevy(): HevySyncResult {
  const apiKey = getProviderSecret("hevy", "token");
  if (!apiKey) return { ok: false, error: "integration not connected", code: "integration_not_connected", provider: "hevy" };
  return { ok: true, fetched: 0, created: 0, updated: 0 };
}

export function getGoogleIntegrationSettings() {
  return getGoogleSettings();
}

export function saveGoogleIntegrationSettings(input: unknown) {
  return saveGoogleSettings(input);
}

export function disconnectGoogle(): { ok: true } {
  disconnectProvider("google");
  return { ok: true };
}

export function parseHevySettings(value: unknown): { apiKey: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("apiKey" in value) || typeof value.apiKey !== "string") return null;
  const apiKey = value.apiKey.trim();
  return apiKey ? { apiKey } : null;
}

function providerToIntegration(provider: ProviderDefinition): IntegrationCatalogEntry {
  return {
    id: provider.id,
    displayName: provider.displayName,
    category: provider.category,
    description: providerDescription(provider.id),
    capabilities: provider.capabilities,
    authType: provider.authType,
    status: provider.status,
    connectProvider: provider.authType === "oauth2" ? provider.id : undefined,
    setupHint: provider.authType === "token" ? "Add a local API token." : undefined,
  };
}

function providerDescription(providerId: string): string {
  if (providerId === "google") return "Calendar, Gmail, and Drive context for scheduling and retrieval.";
  if (providerId === "google-calendar") return "Calendar provider for schedule context.";
  if (providerId === "google-tasks") return "Task provider for priority queues.";
  if (providerId === "spotify") return "Now-playing context for focus sessions.";
  if (providerId === "hevy") return "Workout sync for health dashboards.";
  return "Registered local provider.";
}
