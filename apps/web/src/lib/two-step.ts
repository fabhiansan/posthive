// Two-step verification on the web: what GET /user/two-step answers, and the small pure helpers the dialog and the login use.
// The codes themselves are made and checked by the API (lib/totp.ts there); the browser never holds a secret longer than setup.

export interface ApiTwoStep {
  enabled: boolean;
  /** ISO time it was switched on; null while it is off. */
  enabledAt: string | null;
  /** Recovery codes not yet used. */
  recoveryLeft: number;
  /** False for an account that signs in with Google or LinkedIn: it has no password here, and their provider has its own verification. */
  available: boolean;
}

/** The setup key as people copy it into an app: groups of four ("JBSW Y3DP EHPK 3PXP"). The app ignores the spaces. */
export function groupedKey(key: string): string {
  return key.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

/** Six digits, or a recovery code (ten letters and digits, dash or not): the two things the second step takes. */
export function looksLikeCode(typed: string): boolean {
  const t = typed.trim().toUpperCase().replace(/[\s-]/g, "");
  return /^\d{6}$/.test(t) || /^[A-Z2-9]{10}$/.test(t);
}

/** The text of the file the person saves: the codes, what they are for, and when they were made. */
export function recoveryCodesFile(codes: readonly string[], product: string, email: string, madeOn: Date): string {
  const day = madeOn.toISOString().slice(0, 10);
  return [
    `${product} recovery codes for ${email}`,
    `Made on ${day}`,
    "",
    "Each code works once, when you cannot use your authenticator app.",
    "Keep this file somewhere safe. Anyone who has a code and your password can sign in.",
    "",
    ...codes,
    "",
  ].join("\n");
}

/** "On since 18 Nov 2026 · 8 recovery codes left": the line under the row on My Profile. `formatDay` turns the ISO time into the day. */
export function twoStepDetail(state: Pick<ApiTwoStep, "enabledAt" | "recoveryLeft">, formatDay: (iso: string) => string): string {
  const day = state.enabledAt ? formatDay(state.enabledAt) : "";
  const since = day ? `On since ${day}` : "On";
  const left = state.recoveryLeft === 1 ? "1 recovery code left" : `${state.recoveryLeft} recovery codes left`;
  return `${since} · ${left}`;
}

/** The words for the row when it is off, and for an account that cannot use it. */
export const TWO_STEP_OFF = "Ask for a code from an authenticator app each time you sign in.";
export const TWO_STEP_UNAVAILABLE = "Your account signs in with Google or LinkedIn, which has its own verification.";
