"use node";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export type EncryptedCredentials = {
  algorithm: "aes-256-gcm";
  keyVersion: number;
  nonce: string;
  ciphertext: string;
};

function key(): Buffer {
  const encoded = process.env.ANORVIS_CREDENTIAL_KEY;
  if (!encoded) {
    throw new Error("ANORVIS_CREDENTIAL_KEY is not configured");
  }
  const value = Buffer.from(encoded, "base64");
  if (value.length !== 32) {
    throw new Error("ANORVIS_CREDENTIAL_KEY must be a base64-encoded 32-byte key");
  }
  return value;
}

export function encryptCredentials(
  credentials: Record<string, string>,
): EncryptedCredentials {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: "aes-256-gcm",
    keyVersion: 1,
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"),
  };
}

export function decryptCredentials(
  encrypted: EncryptedCredentials,
): Record<string, string> {
  if (encrypted.algorithm !== "aes-256-gcm" || encrypted.keyVersion !== 1) {
    throw new Error("Provider credentials use an unsupported encryption version");
  }
  const payload = Buffer.from(encrypted.ciphertext, "base64");
  if (payload.length < 17) throw new Error("Encrypted provider credentials are invalid");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(encrypted.nonce, "base64"),
  );
  decipher.setAuthTag(payload.subarray(payload.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(payload.subarray(0, payload.length - 16)),
    decipher.final(),
  ]).toString("utf8");
  const decoded: unknown = JSON.parse(plaintext);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Decrypted provider credentials are invalid");
  }
  const credentials: Record<string, string> = {};
  for (const [name, value] of Object.entries(decoded)) {
    if (typeof value !== "string") {
      throw new Error("Decrypted provider credentials are invalid");
    }
    credentials[name] = value;
  }
  return credentials;
}

export function randomState(): string {
  return randomBytes(32).toString("base64url");
}

export function stateHash(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}
