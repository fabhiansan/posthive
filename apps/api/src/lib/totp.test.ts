// Two-step codes. The vectors are the ones in RFC 6238 appendix B and RFC 4226 appendix D, so a correct answer here
// is the same answer every authenticator app gives.
import { describe, expect, it } from "vitest";
import {
  RECOVERY_CODE_COUNT,
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  generateSecret,
  hashRecoveryCode,
  hotp,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
  otpauthUrl,
  stepOf,
  totpAt,
  verifyTotp,
} from "./totp.js";

// RFC 6238 appendix B uses these ASCII secrets (20, 32 and 64 bytes for SHA-1, SHA-256 and SHA-512)
const SHA1_SECRET = Buffer.from("12345678901234567890");
const SHA256_SECRET = Buffer.from("12345678901234567890123456789012");
const SHA512_SECRET = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234");

describe("hotp: RFC 4226 appendix D", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  it.each(expected.map((code, counter) => [counter, code] as const))("counter %i is %s", (counter, code) => {
    expect(hotp(SHA1_SECRET, counter)).toBe(code);
  });
});

describe("totp: RFC 6238 appendix B (8 digits there, the last 6 here)", () => {
  // [unix time, sha1, sha256, sha512] as printed in the RFC, 8 digits; six digits are the last six of them
  const vectors: Array<[number, string, string, string]> = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  it.each(vectors)("t=%i", (time, sha1, sha256, sha512) => {
    const step = Math.floor(time / 30);
    expect(hotp(SHA1_SECRET, step, "sha1")).toBe(sha1.slice(2));
    expect(hotp(SHA256_SECRET, step, "sha256")).toBe(sha256.slice(2));
    expect(hotp(SHA512_SECRET, step, "sha512")).toBe(sha512.slice(2));
  });
});

describe("base32", () => {
  it("encodes and decodes the RFC 4648 test vectors", () => {
    for (const [plain, coded] of [["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]]) {
      expect(base32Encode(Buffer.from(plain))).toBe(coded);
      expect(base32Decode(coded).toString()).toBe(plain);
    }
  });

  it("takes a key as people type it: lower case, in groups, with dashes or padding", () => {
    expect(base32Decode("mzxw 6ytb-oi==").toString()).toBe("foobar");
  });

  it("refuses a character that is not base32 (so a mistyped key is not read as a different key)", () => {
    expect(() => base32Decode("MZXW1")).toThrow(); // 1 is not in the alphabet
    expect(() => base32Decode("MZXW!")).toThrow();
  });

  it("a generated secret is 32 base32 characters (160 bits) and never repeats", () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateSecret()).not.toBe(a);
    expect(base32Decode(a)).toHaveLength(20);
  });
});

describe("verifyTotp", () => {
  const secret = base32Encode(SHA1_SECRET);
  const at = (t: number) => new Date(t * 1000);

  it("the code of this moment is accepted and says which step it was", () => {
    expect(verifyTotp(secret, "287082", at(45))).toBe(1); // 287082 is counter 1 (t 30..59)
    expect(totpAt(secret, at(45))).toBe("287082");
  });

  it("one step early and one step late are accepted (a clock a few seconds off), two are not", () => {
    const code = hotp(SHA1_SECRET, 100);
    expect(verifyTotp(secret, code, at(100 * 30 + 5))).toBe(100);
    expect(verifyTotp(secret, code, at(99 * 30 + 5))).toBe(100); // the phone is a step ahead
    expect(verifyTotp(secret, code, at(101 * 30 + 5))).toBe(100); // the phone is a step behind
    expect(verifyTotp(secret, code, at(102 * 30 + 5))).toBeNull();
    expect(verifyTotp(secret, code, at(98 * 30 + 5))).toBeNull();
  });

  it("a code that was already accepted (or an older one) is refused: it cannot be used twice", () => {
    const code = hotp(SHA1_SECRET, 100);
    const now = at(100 * 30 + 5);
    expect(verifyTotp(secret, code, now, null)).toBe(100);
    expect(verifyTotp(secret, code, now, 100)).toBeNull(); // the same step again
    expect(verifyTotp(secret, code, now, 101)).toBeNull(); // a later step was already used
    expect(verifyTotp(secret, code, now, 99)).toBe(100); // an earlier use does not matter
  });

  it("a wrong code, or something that is not six digits, is refused", () => {
    const now = at(100 * 30 + 5);
    for (const bad of ["000000", "12345", "1234567", "abcdef", "12 345", "", "１２３４５６"]) expect(verifyTotp(secret, bad, now)).toBeNull();
  });

  it("a stored secret that is damaged is a refusal, not a crash", () => {
    expect(verifyTotp("not base32!", "123456", new Date())).toBeNull();
  });

  it("stepOf puts a moment in its 30-second step", () => {
    expect(stepOf(at(0))).toBe(0);
    expect(stepOf(at(29.9))).toBe(0);
    expect(stepOf(at(30))).toBe(1);
  });
});

describe("otpauthUrl", () => {
  it("is what an authenticator app scans: the issuer and account the person sees, the secret, six digits, 30 seconds", () => {
    const url = new URL(otpauthUrl("JBSWY3DPEHPK3PXP", "puteri@example.com", "Postly"));
    expect(url.protocol).toBe("otpauth:");
    expect(url.host).toBe("totp");
    expect(decodeURIComponent(url.pathname)).toBe("/Postly:puteri@example.com");
    expect(Object.fromEntries(url.searchParams)).toEqual({ secret: "JBSWY3DPEHPK3PXP", issuer: "Postly", algorithm: "SHA1", digits: "6", period: "30" });
  });

  it("an account with characters that need escaping still reads back the same", () => {
    const url = new URL(otpauthUrl("JBSWY3DPEHPK3PXP", "a+b&c@example.com", "My Co"));
    expect(decodeURIComponent(url.pathname)).toBe("/My Co:a+b&c@example.com");
    expect(url.searchParams.get("issuer")).toBe("My Co");
  });
});

describe("recovery codes", () => {
  it("look like ABCDE-FGHJK, from an alphabet with no 0 O 1 I L", () => {
    for (let i = 0; i < 200; i++) expect(generateRecoveryCode()).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
  });

  it("do not repeat", () => {
    const codes = new Set(Array.from({ length: 500 }, generateRecoveryCode));
    expect(codes.size).toBe(500);
    expect(RECOVERY_CODE_COUNT).toBe(8);
  });

  it("are typed any way a person might: lower case, no dash, spaces", () => {
    expect(normalizeRecoveryCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode(" ABCDE FGHJK ")).toBe("ABCDEFGHJK");
    expect(hashRecoveryCode("abcde-fghjk")).toBe(hashRecoveryCode("ABCDEFGHJK"));
  });

  it("a hash is a plain sha256 hex and differs for another code", () => {
    expect(hashRecoveryCode("ABCDE-FGHJK")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode("ABCDE-FGHJK")).not.toBe(hashRecoveryCode("ABCDE-FGHJM"));
  });

  it("tells a recovery code from an authenticator code by its shape", () => {
    expect(looksLikeRecoveryCode("ABCDE-FGHJK")).toBe(true);
    expect(looksLikeRecoveryCode("abcdefghjk")).toBe(true);
    expect(looksLikeRecoveryCode("123456")).toBe(false);
    expect(looksLikeRecoveryCode("ABCDE-FGHJ0")).toBe(false); // 0 is not in the alphabet
  });
});
