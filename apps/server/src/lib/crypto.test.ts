import { describe, expect, it } from "vitest";
import { decryptString, encryptString } from "./crypto.js";

const key = "a".repeat(64);
const otherKey = "b".repeat(64);

describe("credential crypto", () => {
  it("round-trips a JSON string", () => {
    const plaintext = JSON.stringify({ accessToken: "tok", refreshToken: "ref" });
    expect(decryptString(encryptString(plaintext, key), key)).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext", () => {
    expect(encryptString("same", key)).not.toBe(encryptString("same", key));
  });

  it("rejects tampered ciphertext", () => {
    const payload = encryptString("secret", key);
    const bytes = Buffer.from(payload, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    expect(() => decryptString(bytes.toString("base64"), key)).toThrow();
  });

  it("rejects decryption with a different key", () => {
    expect(() => decryptString(encryptString("secret", key), otherKey)).toThrow();
  });

  it("rejects malformed keys", () => {
    expect(() => encryptString("x", "short")).toThrow(/64 hex/);
    expect(() => decryptString("AAAA", "not-hex".repeat(10))).toThrow(/64 hex/);
  });
});
