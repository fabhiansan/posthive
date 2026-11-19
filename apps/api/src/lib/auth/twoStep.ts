// Two-step verification (an authenticator app) on top of the password: turning it on and off, the second step of a login,
// and the recovery codes. The arithmetic of the codes is in lib/totp.ts; this is what is kept and what is allowed.
//
// What an attacker gets for a stolen password or a hijacked session:
//  - a login that needs a code waits in a TotpChallenge: 5 minutes, 5 wrong codes, and the 5 are counted BEFORE the code is
//    looked at, in the same write, so many guesses sent at once still count as 5;
//  - a code can be used once (the newest accepted 30-second step is kept, and moved forward in a conditional write);
//  - more than 10 wrong codes on an account in 15 minutes locks the second step for everybody, whatever the challenge;
//  - the secret is encrypted at rest and shown only while setup is running; recovery codes are shown once and kept as hashes.
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../prisma.js";
import { decrypt, encrypt } from "../encryption.js";
import { WRONG_CODE } from "../loginHistory.js";
import { cleanUserAgent } from "../deviceLabel.js";
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  generateSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from "../totp.js";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const ACCOUNT_MAX_WRONG = 10;
export const ACCOUNT_WRONG_WINDOW_MS = 15 * 60 * 1000;

export type CodeCheck = "ok" | "wrong" | "locked";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Whether the account has had too many wrong codes lately. Called AFTER this guess was written down, so the count includes it:
 * of many guesses sent at the same moment, each writes its line and then counts, and only the first ACCOUNT_MAX_WRONG see a
 * number within the limit. (Counting first and writing afterwards lets a whole burst pass the same count.)
 */
async function locked(userId: string, now: Date): Promise<boolean> {
  const wrong = await prisma.loginEvent.count({
    where: { userId, success: false, failure: WRONG_CODE, at: { gte: new Date(now.getTime() - ACCOUNT_WRONG_WINDOW_MS) } },
  });
  return wrong > ACCOUNT_MAX_WRONG;
}

/** The guess, as a line of the person's sign-in history. It is NOT swallowed on failure like other history lines: a guess that was not counted is a hole. */
async function writeGuess(userId: string, userAgent: string | null | undefined): Promise<string> {
  const line = await prisma.loginEvent.create({
    data: { userId, userAgent: cleanUserAgent(userAgent), success: false, failure: WRONG_CODE },
    select: { id: true },
  });
  return line.id;
}

export async function twoStepState(userId: string): Promise<{ enabled: boolean; enabledAt: Date | null; recoveryLeft: number }> {
  const [user, recoveryLeft] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } }),
    prisma.recoveryCode.count({ where: { userId, usedAt: null } }),
  ]);
  return { enabled: Boolean(user?.totpEnabledAt), enabledAt: user?.totpEnabledAt ?? null, recoveryLeft };
}

// ── Turning it on ───────────────────────────────────────────────────────────

/** A fresh secret, kept (encrypted) but not yet counting. Null when it is already on. */
export async function beginSetup(userId: string, account: string, issuer: string): Promise<{ setupKey: string; otpauthUrl: string } | null> {
  const secret = generateSecret();
  // `totpEnabledAt: null` is in the write: a person who already has it on cannot have their secret swapped by a second setup
  const { count } = await prisma.user.updateMany({ where: { id: userId, totpEnabledAt: null }, data: { totpSecret: encrypt(secret), totpLastStep: null } });
  return count === 0 ? null : { setupKey: secret, otpauthUrl: otpauthUrl(secret, account, issuer) };
}

export type FinishSetup = { result: "ok"; recoveryCodes: string[] } | { result: "wrong" | "not-started" | "already" | "locked" };

/** The code from the app proves the person can read it: only then does the secret count, and the recovery codes are made. */
export async function finishSetup(userId: string, code: string, now: Date = new Date()): Promise<FinishSetup> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { totpSecret: true, totpEnabledAt: true } });
  if (user?.totpEnabledAt) return { result: "already" };
  if (!user?.totpSecret) return { result: "not-started" };
  if (await locked(userId, now)) return { result: "locked" };

  const secret = decrypt(user.totpSecret);
  const step = verifyTotp(secret, code.trim(), now, null);
  if (step === null) return { result: "wrong" };

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const done = await prisma.$transaction(async (tx) => {
    // the secret that was checked is the one that is switched on, and only once
    const { count } = await tx.user.updateMany({ where: { id: userId, totpEnabledAt: null, totpSecret: user.totpSecret }, data: { totpEnabledAt: now, totpLastStep: step } });
    if (count === 0) return false;
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({ data: recoveryCodes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })) });
    return true;
  });
  return done ? { result: "ok", recoveryCodes } : { result: "already" };
}

// ── The second step ─────────────────────────────────────────────────────────

/**
 * Checks what the person typed: the six digits of the app, or a recovery code. A wrong one is written to their sign-in
 * history. A recovery code is spent by the same write that accepts it.
 */
export async function verifySecondFactor(userId: string, typed: string, userAgent?: string | null, now: Date = new Date()): Promise<CodeCheck> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { totpSecret: true, totpEnabledAt: true, totpLastStep: true } });
  if (!user?.totpSecret || !user.totpEnabledAt) return "wrong";

  // Every guess is written down first, counted (itself included), and taken back only if the code turns out to be right.
  const guess = await writeGuess(userId, userAgent);
  if (await locked(userId, now)) return "locked";

  const code = typed.trim();
  let accepted = false;
  if (looksLikeRecoveryCode(code)) {
    const { count } = await prisma.recoveryCode.updateMany({ where: { userId, codeHash: hashRecoveryCode(code), usedAt: null }, data: { usedAt: now } });
    accepted = count === 1;
  } else {
    const step = verifyTotp(decrypt(user.totpSecret), code, now, user.totpLastStep);
    if (step !== null) {
      // the newest step only moves forward: of two requests carrying the same code, one of them gets count 0
      const { count } = await prisma.user.updateMany({ where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step } });
      accepted = count === 1;
    }
  }
  // a right code is not a wrong guess: its line goes, so signing in does not use up the allowance
  if (accepted) await prisma.loginEvent.deleteMany({ where: { id: guess } });
  return accepted ? "ok" : "wrong";
}

export async function turnOff(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null } }),
    prisma.recoveryCode.deleteMany({ where: { userId } }),
  ]);
}

/** Eight new codes; the old ones stop working. */
export async function newRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })) }),
  ]);
  return codes;
}

// ── A login waiting for its code ────────────────────────────────────────────

/**
 * Made only after the password was right. The token goes to the browser; the database keeps its hash.
 * One challenge is alive per person: a new one replaces the old. Otherwise every password login (the password is all it takes)
 * would add a challenge with 5 fresh tries, and the number of tries would be the number of logins.
 */
export async function createChallenge(userId: string, userAgent: string | null | undefined, remember: boolean, now: Date = new Date()): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await prisma.totpChallenge.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { userId }] } });
  await prisma.totpChallenge.create({
    data: { userId, tokenHash: sha256(token), userAgent: userAgent ?? null, remember, expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS) },
  });
  return token;
}

export type Answer =
  | { result: "ok"; userId: string; userAgent: string | null; remember: boolean }
  | { result: "expired" | "wrong" | "locked" };

/** "expired" also covers a challenge that never existed, and one that has used its 5 tries: the browser starts over from the password. */
export async function answerChallenge(token: string, code: string, now: Date = new Date()): Promise<Answer> {
  const tokenHash = sha256(token);
  const challenge = await prisma.totpChallenge.findUnique({ where: { tokenHash } });
  if (!challenge) return { result: "expired" };

  // one try is spent before the code is looked at, in the same write that checks there are tries left AND that the challenge
  // has not run out: the condition is in the write, not in a check made on what was read, so many guesses at once cannot get past it
  const { count } = await prisma.totpChallenge.updateMany({
    where: { id: challenge.id, attempts: { lt: CHALLENGE_MAX_ATTEMPTS }, expiresAt: { gt: now } },
    data: { attempts: { increment: 1 } },
  });
  if (count === 0) return { result: "expired" };

  const check = await verifySecondFactor(challenge.userId, code, challenge.userAgent, now);
  if (check !== "ok") return { result: check };

  // single use: of two requests with the right code, only the one that deletes the row gets a session
  const gone = await prisma.totpChallenge.deleteMany({ where: { id: challenge.id } });
  if (gone.count !== 1) return { result: "expired" };
  return { result: "ok", userId: challenge.userId, userAgent: challenge.userAgent, remember: challenge.remember };
}
