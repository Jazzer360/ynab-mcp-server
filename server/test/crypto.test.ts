import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptJson, encryptJson, hashToken, pkceChallenge, randomToken, safeEqual } from "../src/crypto.js";

describe("credential helpers", () => {
  it("encrypts and decrypts token data", () => {
    const key = randomBytes(32);
    const encrypted = encryptJson({ accessToken: "secret", expiresAt: 123 }, key);
    expect(encrypted).not.toContain("secret");
    expect(decryptJson(encrypted, key)).toEqual({ accessToken: "secret", expiresAt: 123 });
  });

  it("creates stable hashes and S256-compatible PKCE challenges", () => {
    const token = randomToken();
    expect(hashToken(token)).toBe(pkceChallenge(token));
    expect(safeEqual(hashToken(token), hashToken(token))).toBe(true);
    expect(safeEqual(hashToken(token), hashToken(`${token}x`))).toBe(false);
  });
});
