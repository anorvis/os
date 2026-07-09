import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getHomeDir } from "../../paths";
import { getDatabase } from "../db/database";

export type SecretProvider = {
  set(name: string, value: string, now?: Date): string;
  get(ref: string): string | null;
  delete(ref: string): void;
  describe(ref: string | null | undefined): "keychain" | "local" | null;
};

const LOCAL_PREFIX = "secret:";
const KEYCHAIN_PREFIX = "keychain:";
const KEYCHAIN_SERVICE = "anorvis-os";
let overrideProvider: SecretProvider | undefined;

export function setSecret(name: string, value: string, now = new Date()): string {
  return getSecretProvider().set(name, value, now);
}

export function setNamedSecret(name: string, value: string, now = new Date()): { ref: string; provider: "keychain" | "local"; name: string } {
  const ref = setSecret(name, value, now);
  const provider = describeSecretProvider(ref);
  if (!provider) throw new Error("unknown_secret_provider");
  return { ref, provider, name: secretId(name) };
}

export function getSecret(ref: string | null | undefined): string | null {
  return ref ? providerForRef(ref).get(ref) : null;
}

export function deleteSecret(ref: string | null | undefined): void {
  if (ref) providerForRef(ref).delete(ref);
}

export function describeSecretProvider(ref: string | null | undefined): "keychain" | "local" | null {
  return ref?.startsWith(KEYCHAIN_PREFIX) ? "keychain" : ref?.startsWith(LOCAL_PREFIX) ? "local" : null;
}

export function setSecretProviderForTests(provider: SecretProvider | undefined): void {
  overrideProvider = provider;
}

function getSecretProvider(): SecretProvider {
  if (overrideProvider) return overrideProvider;
  if (process.env.ANORVIS_SECRET_PROVIDER === "keychain") return keychainProvider;
  if (process.env.ANORVIS_SECRET_PROVIDER === "local") return localEncryptedProvider;
  return process.platform === "darwin" && keychainAvailable() ? keychainProvider : localEncryptedProvider;
}

function providerForRef(ref: string): SecretProvider {
  if (ref.startsWith(KEYCHAIN_PREFIX)) return keychainProvider;
  if (ref.startsWith(LOCAL_PREFIX)) return localEncryptedProvider;
  return overrideProvider ?? getSecretProvider();
}

const localEncryptedProvider: SecretProvider = {
  set(name, value, now = new Date()) {
    const id = secretId(name);
    const key = readOrCreateLocalKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([encrypted, tag]).toString("base64");
    const timestamp = now.toISOString();
    getDatabase().query(`
      INSERT INTO secret_records (id, provider, nonce, ciphertext, created_at, updated_at)
      VALUES (?1, 'local', ?2, ?3, ?4, ?4)
      ON CONFLICT(id) DO UPDATE SET provider = 'local', nonce = excluded.nonce, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at
    `).run(id, nonce.toString("base64"), payload, timestamp);
    return `${LOCAL_PREFIX}${id}`;
  },
  get(ref) {
    const id = parseRef(ref, LOCAL_PREFIX);
    if (!id) return null;
    const row = getDatabase().query<{ nonce: string; ciphertext: string }, [string]>("SELECT nonce, ciphertext FROM secret_records WHERE id = ?1 AND provider = 'local'").get(id);
    if (!row) return null;
    const key = readOrCreateLocalKey();
    const nonce = Buffer.from(row.nonce, "base64");
    const payload = Buffer.from(row.ciphertext, "base64");
    if (payload.length < 16) return null;
    const encrypted = payload.subarray(0, payload.length - 16);
    const tag = payload.subarray(payload.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  },
  delete(ref) {
    const id = parseRef(ref, LOCAL_PREFIX);
    if (id) getDatabase().query("DELETE FROM secret_records WHERE id = ?1").run(id);
  },
  describe(ref) {
    return ref?.startsWith(LOCAL_PREFIX) ? "local" : ref?.startsWith(KEYCHAIN_PREFIX) ? "keychain" : null;
  },
};

const keychainProvider: SecretProvider = {
  set(name, value) {
    const id = secretId(name);
    const result = Bun.spawnSync(["security", "add-generic-password", "-a", id, "-s", KEYCHAIN_SERVICE, "-w", value, "-U"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return localEncryptedProvider.set(name, value);
    return `${KEYCHAIN_PREFIX}${id}`;
  },
  get(ref) {
    const id = parseRef(ref, KEYCHAIN_PREFIX);
    if (!id) return localEncryptedProvider.get(ref);
    const result = Bun.spawnSync(["security", "find-generic-password", "-a", id, "-s", KEYCHAIN_SERVICE, "-w"], { stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trimEnd() : null;
  },
  delete(ref) {
    const id = parseRef(ref, KEYCHAIN_PREFIX);
    if (!id) {
      localEncryptedProvider.delete(ref);
      return;
    }
    Bun.spawnSync(["security", "delete-generic-password", "-a", id, "-s", KEYCHAIN_SERVICE], { stdout: "pipe", stderr: "pipe" });
  },
  describe(ref) {
    return ref?.startsWith(KEYCHAIN_PREFIX) ? "keychain" : localEncryptedProvider.describe(ref);
  },
};

function keychainAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  const result = Bun.spawnSync(["security", "list-keychains"], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0;
}

function readOrCreateLocalKey(): Buffer {
  const path = process.env.ANORVIS_SECRET_KEY_PATH ?? join(getHomeDir(), ".anorvis", "os", "secret-key");
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error("Invalid Anorvis secret key.");
  return key;
}

function secretId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "secret";
}

function parseRef(ref: string, prefix: string): string | null {
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}
