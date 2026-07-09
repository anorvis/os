import { Effect, Schema } from "effect";
import { InvalidStateError } from "../effect/errors";
import { decodeUnknown } from "../effect/schema";
import { getDataRoot } from "../../paths";
import { getDatabasePath } from "../db/database";

const StorageModeSchema = Schema.Literal("centralized", "readonly-replica");

export type StorageMode = typeof StorageModeSchema.Type;

export type LocalAuthorityConfig = {
  baseUrl: string;
  bindHost: string;
  port: number;
  dataRoot: string;
  databasePath: string;
  storageMode: StorageMode;
  tailnetName: string | null;
};

export function readLocalAuthorityConfigEffect(env = process.env): Effect.Effect<LocalAuthorityConfig, InvalidStateError> {
  return Effect.try({
    try: () => readLocalAuthorityConfigUnsafe(env),
    catch: (error) => error instanceof InvalidStateError ? error : new InvalidStateError({ message: error instanceof Error ? error.message : String(error) }),
  });
}

export function readLocalAuthorityConfig(env = process.env): LocalAuthorityConfig {
  return Effect.runSync(readLocalAuthorityConfigEffect(env));
}

function readLocalAuthorityConfigUnsafe(env: NodeJS.ProcessEnv): LocalAuthorityConfig {
  const bindHost = env.ANORVIS_OS_HOST?.trim() || "127.0.0.1";
  const portValue = env.ANORVIS_OS_PORT ?? env.PORT ?? "8787";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port <= 0) throw new InvalidStateError({ message: "invalid ANORVIS_OS_PORT" });
  const storageMode = readStorageMode(env.ANORVIS_STORAGE_MODE);
  const baseUrl = env.ANORVIS_OS_URL?.trim() || `http://${hostForUrl(bindHost)}:${port}`;
  return {
    baseUrl,
    bindHost,
    port,
    dataRoot: getDataRoot(),
    databasePath: getDatabasePath(),
    storageMode,
    tailnetName: env.ANORVIS_TAILNET_NAME?.trim() || env.TAILSCALE_HOSTNAME?.trim() || null,
  };
}

function readStorageMode(value: string | undefined): StorageMode {
  if (!value) return "centralized";
  try {
    return decodeUnknown(StorageModeSchema, value);
  } catch {
    throw new InvalidStateError({ message: `unknown_storage_mode:${value}` });
  }
}

function hostForUrl(host: string): string {
  return host === "::1" ? "[::1]" : host;
}
