import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { SchemaValidationError } from "../../core/effect/errors";
import { decodeUnknown } from "../../core/effect/schema";
import { getDatabase } from "../../core/db/database";
import { deleteSecret, describeSecretProvider, getSecret, setNamedSecret } from "../../core/secrets/secrets";
import { InvalidProviderInput, ProviderNotFound, ProviderSecretFailed, type ProviderError } from "./errors";
import { ProviderConnectionInputSchema, ProviderDefinitionInputSchema, ProviderStatusSchema, type ProviderAuthType, type ProviderCategory, type ProviderConnectionInput, type ProviderStatus } from "./schema";

export type ProviderDefinition = {
  id: string;
  displayName: string;
  category: ProviderCategory;
  capabilities: string[];
  authType: ProviderAuthType;
  enabled: boolean;
  status: ProviderStatus;
  secretProvider: "keychain" | "local" | null;
};

export type ProviderConnectionResult = { ok: true; providerId: string; status: ProviderStatus; secretProvider: "keychain" | "local" | null };

type ProviderRow = {
  id: string;
  display_name: string;
  category: ProviderCategory;
  capabilities_json: string;
  auth_type: ProviderAuthType;
  enabled: number;
  status: ProviderStatus | null;
  secret_refs_json: string | null;
};

export type ProviderConnectionState = {
  status: ProviderStatus;
  settingsJson: string;
  secretRefsJson: string;
  updatedAt: string;
};

type ConnectionRow = {
  status: ProviderStatus;
  settings_json: string;
  secret_refs_json: string;
  updated_at: string;
};

const CapabilitiesJsonSchema = Schema.parseJson(Schema.Array(Schema.String));
const SecretRefsJsonSchema = Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.String }));

export function listProviders(): { providers: ProviderDefinition[] } {
  const providers = getDatabase().query<ProviderRow, []>(`
    SELECT definitions.id, definitions.display_name, definitions.category, definitions.capabilities_json, definitions.auth_type, definitions.enabled, connections.status, connections.secret_refs_json
    FROM provider_definitions definitions
    LEFT JOIN provider_connections connections ON connections.provider_id = definitions.id
    ORDER BY definitions.category ASC, definitions.display_name ASC
  `).all().map(rowToProvider);
  return { providers };
}

export function upsertProviderDefinitionEffect(input: unknown, now = new Date()): Effect.Effect<ProviderDefinition, ProviderError> {
  return Effect.try({
    try: () => upsertProviderDefinitionUnsafe(input, now),
    catch: providerEffectError,
  });
}

export function upsertProviderDefinition(input: unknown, now = new Date()): ProviderDefinition {
  return Effect.runSync(upsertProviderDefinitionEffect(input, now));
}

export function connectProviderEffect(providerId: string, input: ProviderConnectionInput = {}, now = new Date()): Effect.Effect<ProviderConnectionResult, ProviderError> {
  return Effect.try({
    try: () => connectProviderUnsafe(providerId, input, now),
    catch: providerEffectError,
  });
}

export function connectProvider(providerId: string, input: ProviderConnectionInput = {}, now = new Date()): ProviderConnectionResult | null {
  return Effect.runSync(Effect.match(connectProviderEffect(providerId, input, now), { onFailure: legacyProviderFailure, onSuccess: (value) => value }));
}

export function saveProviderConnection(providerId: string, input: ProviderConnectionInput = {}, status: ProviderStatus = "connected", now = new Date()): ProviderConnectionResult {
  return Effect.runSync(Effect.match(saveProviderConnectionEffect(providerId, input, status, now), { onFailure: legacyProviderFailure, onSuccess: (value) => value })) as ProviderConnectionResult;
}

export function saveProviderConnectionEffect(providerId: string, input: ProviderConnectionInput = {}, status: ProviderStatus = "connected", now = new Date()): Effect.Effect<ProviderConnectionResult, ProviderError> {
  return Effect.try({
    try: () => saveProviderConnectionUnsafe(providerId, input, status, now),
    catch: providerEffectError,
  });
}

export function disconnectProviderEffect(providerId: string, now = new Date()): Effect.Effect<{ ok: true }, ProviderError> {
  return Effect.try({
    try: () => disconnectProviderUnsafe(providerId, now),
    catch: providerEffectError,
  });
}

export function disconnectProvider(providerId: string, now = new Date()): { ok: true } | null {
  return Effect.runSync(Effect.match(disconnectProviderEffect(providerId, now), { onFailure: legacyProviderFailure, onSuccess: (value) => value }));
}

function legacyProviderFailure(error: ProviderError): null {
  if (error instanceof ProviderNotFound) return null;
  throw error;
}

export function getProviderSecret(providerId: string, secretName: string): string | null {
  const ref = parseSecretRefs(readConnection(providerId)?.secret_refs_json ?? "{}")[secretName];
  try {
    return getSecret(ref);
  } catch {
    return null;
  }
}

export function getProviderConnectionState(providerId: string): ProviderConnectionState | null {
  const row = readConnection(providerId);
  return row
    ? { status: row.status, settingsJson: row.settings_json, secretRefsJson: row.secret_refs_json, updatedAt: row.updated_at }
    : null;
}

export function getProviderDefinition(providerId: string): ProviderDefinition | null {
  const row = getDatabase().query<ProviderRow, [string]>(`
    SELECT definitions.id, definitions.display_name, definitions.category, definitions.capabilities_json, definitions.auth_type, definitions.enabled, connections.status, connections.secret_refs_json
    FROM provider_definitions definitions
    LEFT JOIN provider_connections connections ON connections.provider_id = definitions.id
    WHERE definitions.id = ?1
  `).get(providerId);
  return row ? rowToProvider(row) : null;
}

function upsertProviderDefinitionUnsafe(input: unknown, now: Date): ProviderDefinition {
  const value = decodeUnknown(ProviderDefinitionInputSchema, input);
  const id = value.id.trim();
  const displayName = value.displayName.trim();
  const capabilities = value.capabilities.map((capability) => capability.trim());
  if (!displayName) throw new InvalidProviderInput({ message: "displayName is required" });
  if (capabilities.some((capability) => !capability)) throw new InvalidProviderInput({ message: "capabilities must be a string array" });
  const timestamp = now.toISOString();
  getDatabase().query(`
    INSERT INTO provider_definitions (id, display_name, category, capabilities_json, auth_type, enabled, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, category = excluded.category, capabilities_json = excluded.capabilities_json, auth_type = excluded.auth_type, enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(id, displayName, value.category, JSON.stringify(capabilities), value.authType, value.enabled === false ? 0 : 1, timestamp);
  const provider = getProviderDefinition(id);
  if (!provider) throw new InvalidProviderInput({ message: "provider upsert failed" });
  return provider;
}

function connectProviderUnsafe(providerId: string, input: ProviderConnectionInput, now: Date): ProviderConnectionResult {
  return saveProviderConnectionUnsafe(providerId, input, "connected", now);
}

function saveProviderConnectionUnsafe(providerId: string, input: ProviderConnectionInput, status: ProviderStatus, now: Date): ProviderConnectionResult {
  if (!providerExists(providerId)) throw new ProviderNotFound({ providerId });
  const decoded = decodeUnknown(ProviderConnectionInputSchema, input);
  const previous = readConnection(providerId);
  const previousSettings = parseSettings(previous?.settings_json ?? "{}");
  const settings = { ...previousSettings, ...(decoded.settings ?? {}) };
  const secrets = decoded.secrets ?? {};
  const previousRefs = parseSecretRefs(previous?.secret_refs_json ?? "{}");
  const secretRefs: Record<string, string> = { ...previousRefs };
  let secretProvider: "keychain" | "local" | null = firstSecretProvider(secretRefs);
  for (const [name, value] of Object.entries(secrets)) {
    const previousRef = secretRefs[name];
    const secret = setNamedSecret(`${providerId}-${name}`, value, now);
    secretRefs[name] = secret.ref;
    secretProvider = secret.provider;
    if (previousRef && previousRef !== secret.ref) deleteSecret(previousRef);
  }
  const timestamp = now.toISOString();
  getDatabase().query(`
    INSERT INTO provider_connections (id, provider_id, status, settings_json, secret_refs_json, connected_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?3 = 'connected' THEN ?6 ELSE NULL END, ?6)
    ON CONFLICT(provider_id) DO UPDATE SET status = excluded.status, settings_json = excluded.settings_json, secret_refs_json = excluded.secret_refs_json, connected_at = CASE WHEN excluded.status = 'connected' THEN COALESCE(provider_connections.connected_at, excluded.connected_at) ELSE provider_connections.connected_at END, updated_at = excluded.updated_at
  `).run(randomUUID(), providerId, status, JSON.stringify(settings), JSON.stringify(secretRefs), timestamp);
  return { ok: true, providerId, status, secretProvider };
}

function disconnectProviderUnsafe(providerId: string, now: Date): { ok: true } {
  if (!providerExists(providerId)) throw new ProviderNotFound({ providerId });
  const previous = readConnection(providerId);
  for (const ref of Object.values(parseSecretRefs(previous?.secret_refs_json ?? "{}"))) deleteSecret(ref);
  getDatabase().query(`
    INSERT INTO provider_connections (id, provider_id, status, settings_json, secret_refs_json, connected_at, updated_at)
    VALUES (?1, ?2, 'available', '{}', '{}', NULL, ?3)
    ON CONFLICT(provider_id) DO UPDATE SET status = 'available', settings_json = '{}', secret_refs_json = '{}', connected_at = NULL, updated_at = excluded.updated_at
  `).run(randomUUID(), providerId, now.toISOString());
  return { ok: true };
}

function providerExists(providerId: string): boolean {
  return getDatabase().query<{ present: number }, [string]>("SELECT 1 AS present FROM provider_definitions WHERE id = ?1").get(providerId)?.present === 1;
}

function readConnection(providerId: string): ConnectionRow | null {
  return getDatabase().query<ConnectionRow, [string]>("SELECT status, settings_json, secret_refs_json, updated_at FROM provider_connections WHERE provider_id = ?1").get(providerId) ?? null;
}

function rowToProvider(row: ProviderRow): ProviderDefinition {
  const refs = parseSecretRefs(row.secret_refs_json ?? "{}");
  return {
    id: row.id,
    displayName: row.display_name,
    category: row.category,
    capabilities: parseCapabilities(row.capabilities_json),
    authType: row.auth_type,
    enabled: row.enabled === 1,
    status: decodeUnknown(ProviderStatusSchema, row.status ?? (row.enabled === 1 ? "available" : "unavailable")),
    secretProvider: firstSecretProvider(refs),
  };
}

function providerEffectError(error: unknown): ProviderError {
  if (error instanceof InvalidProviderInput || error instanceof ProviderNotFound || error instanceof ProviderSecretFailed) return error;
  if (error instanceof SchemaValidationError) return new InvalidProviderInput({ message: error.message });
  return new ProviderSecretFailed({ message: error instanceof Error ? error.message : String(error) });
}

function firstSecretProvider(refs: Record<string, string>): "keychain" | "local" | null {
  for (const ref of Object.values(refs)) {
    const provider = describeSecretProvider(ref);
    if (provider) return provider;
  }
  return null;
}


function parseSettings(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
function parseCapabilities(value: string): string[] {
  try {
    return [...decodeUnknown(CapabilitiesJsonSchema, value)];
  } catch {
    return [];
  }
}

function parseSecretRefs(value: string): Record<string, string> {
  try {
    return decodeUnknown(SecretRefsJsonSchema, value);
  } catch {
    return {};
  }
}
