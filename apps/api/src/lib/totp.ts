// Two-step verification codes: the six digits an authenticator app (Google Authenticator, Authy, 1Password) shows and
// changes every 30 seconds. RFC 6238 (TOTP) over RFC 4226 (HOTP), written on node:crypto so there is no package to trust
// with a secret. Pure functions: no I/O, and the clock is an argument.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/** A code is also accepted one step before and after: a phone clock a few seconds off must not lock anybody out. */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 8;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Throws on a character that is not base32; spaces, dashes and case are ignored (people type the key in groups). */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes (160 bits, what RFC 4226 recommends), as the base32 text an authenticator app takes. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The counter's six digits (RFC 4226 section 5.3, dynamic truncation). */
export function hotp(secret: Buffer, counter: number, algorithm: "sha1" | "sha256" | "sha512" = "sha1", digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm, secret).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Which 30-second step a moment falls in. */
export const stepOf = (now: Date): number => Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);

/** The code shown right now for a secret (the tests, and the browser check in the plan, use this as the "phone"). */
export function totpAt(secretBase32: string, now: Date = new Date()): string {
  return hotp(base32Decode(secretBase32), stepOf(now));
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The step a code belongs to, or null when it is wrong. `lastUsedStep` is the newest step already accepted: a code from
 * that step or an earlier one is refused, so a code that was just typed (or watched over a shoulder) cannot be used again.
 */
export function verifyTotp(secretBase32: string, code: string, now: Date = new Date(), lastUsedStep: number | null = null): number | null {
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code)) return null;
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return null;
  }
  const current = stepOf(now);
  let found: number | null = null;
  // every step is compared, whether or not an earlier one matched: the time taken does not say which step it was
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (safeEqual(hotp(secret, step), code) && found === null && (lastUsedStep === null || step > lastUsedStep)) found = step;
  }
  return found;
}

/** What an authenticator app scans: the account name and the issuer are what the person sees in the app. */
export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// ── Recovery codes ──────────────────────────────────────────────────────────

/** Letters and digits without the ones that look alike (0 O 1 I L): a code read off a printed sheet is typed right the first time. */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** "ABCDE-FGHJK": ten characters from a 31-letter alphabet, about 49 bits. Shown once; only a hash is kept. */
export function generateRecoveryCode(): string {
  const pick = () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  const part = () => Array.from({ length: 5 }, pick).join("");
  return `${part()}-${part()}`;
}

/** What is typed is compared in one form: no dash, no spaces, upper case. */
export const normalizeRecoveryCode = (typed: string): string => typed.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function looksLikeRecoveryCode(typed: string): boolean {
  return /^[A-Z2-9]{10}$/.test(normalizeRecoveryCode(typed));
}

/** sha256 of the normalized code. The code is random and long, so a plain hash is enough (nothing to brute-force from a leak). */
export const hashRecoveryCode = (typed: string): string => createHash("sha256").update(normalizeRecoveryCode(typed)).digest("hex");
