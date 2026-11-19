import { prisma } from "./prisma.js";
import { cleanUserAgent } from "./deviceLabel.js";

/** "Recent sign-ins" looks back this far, and the cleanup cron keeps a sign-in this long (lib/cleanupCron.ts). */
export const LOGIN_HISTORY_DAYS = 30;

export const WRONG_PASSWORD = "Wrong password";
/** The password was right and the code from the authenticator app (or a recovery code) was not. */
export const WRONG_CODE = "Wrong two-step code";

/**
 * Writes one line of the account's sign-in history. A history that cannot be written must never stop a person from
 * signing in (or tell an attacker anything), so a failure is logged and swallowed.
 */
export async function recordLoginEvent(event: { userId: string; userAgent?: string | null; failure?: string }): Promise<void> {
  try {
    await prisma.loginEvent.create({
      data: { userId: event.userId, userAgent: cleanUserAgent(event.userAgent), success: !event.failure, failure: event.failure ?? null },
    });
  } catch (err) {
    console.error("[login] history not saved:", err);
  }
}
