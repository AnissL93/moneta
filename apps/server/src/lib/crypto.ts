import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function keyFromHex(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("APP_ENCRYPTION_KEY must be 64 hex characters (32 random bytes)");
  }
  return Buffer.from(keyHex, "hex");
}

// Envelope: base64(iv[12] || authTag[16] || ciphertext) — AES-256-GCM (spec §30).
export function encryptString(plaintext: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptString(payload: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted payload is truncated");
  }
  const iv = bytes.subarray(0, IV_LENGTH);
  const tag = bytes.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = bytes.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
