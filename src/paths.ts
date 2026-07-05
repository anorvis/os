import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OS_SRC_DIR = dirname(fileURLToPath(import.meta.url));

export function getHomeDir(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set. Unable to resolve Anorvis directories.");
  return home;
}

export function getOsRepoRoot(): string {
  return resolve(OS_SRC_DIR, "..", "..");
}

export function getMemoryRoot(): string {
  return join(getHomeDir(), ".anorvis", "memory");
}

export function getLlmWikiRoot(): string {
  return join(getHomeDir(), ".anorvis", "llm-wiki");
}

export function getLogsRoot(): string {
  return join(getHomeDir(), ".anorvis", "logs");
}

export function getTmpRoot(): string {
  return join(getHomeDir(), ".anorvis", "tmp");
}

export const ANORVIS_STORAGE_POLICIES = {
  os: "runtime",
  memory: "legacy",
  "llm-wiki": "memory",
  logs: "log",
  tmp: "runtime",
} as const;

export type AnorvisStorageFolder = keyof typeof ANORVIS_STORAGE_POLICIES;
export type AnorvisStoragePolicy = (typeof ANORVIS_STORAGE_POLICIES)[AnorvisStorageFolder];
