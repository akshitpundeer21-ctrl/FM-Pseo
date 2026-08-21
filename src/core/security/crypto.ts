/**
 * Cryptographic primitives. SERVER ONLY.
 *
 *  - Integration credentials: AES-256-GCM with a key from APP_ENCRYPTION_KEY.
 *    Ciphertext, IV and auth tag are stored separately; plaintext only ever
 *    exists inside the tool-execution call stack.
 *  - Passwords: scrypt with a per-user random salt and timing-safe comparison.
 *  - Session tokens: random 32 bytes; only an HMAC of the token is persisted.
 */
import crypto from "node:crypto";
import { env } from "@/core/config/env";
import { AppError } from "@/core/errors";

const ALGO = "aes-256-gcm";

function keyBuffer(): Buffer {
  const raw = env().APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new AppError(
      "INTERNAL",
      "APP_ENCRYPTION_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new AppError("INTERNAL", `APP_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}).`);
  }
  return buf;
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function encryptSecret(plaintext: string): EncryptedPayload {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyBuffer(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(payload: EncryptedPayload): string {
  try {
    const decipher = crypto.createDecipheriv(ALGO, keyBuffer(), Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]);
    return dec.toString("utf8");
  } catch (e) {
    throw new AppError("INTERNAL", "Failed to decrypt credential (wrong APP_ENCRYPTION_KEY or corrupted record).", {
      cause: e,
    });
  }
}

/** A safe, non-reversible display hint such as `sk-a…7f2c` (never the secret). */
export function secretHint(plaintext: string): string {
  if (plaintext.length <= 8) return `${"*".repeat(Math.max(plaintext.length - 2, 0))}${plaintext.slice(-2)}`;
  return `${plaintext.slice(0, 3)}…${plaintext.slice(-4)} (${plaintext.length} chars)`;
}

// --- passwords -------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt ?? crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, s, SCRYPT_KEYLEN).toString("hex");
  return { hash, salt: s };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// --- session tokens --------------------------------------------------------

export function newSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  const secret = env().SESSION_SECRET || "insecure-dev-secret";
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

/** Stable non-cryptographic hash used for deterministic mock data. */
export function stableHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
