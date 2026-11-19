// Two requests that both read the account BEFORE either one writes, so both see the same old state. A check made on what
// was read cannot tell them apart; only the write can, because it carries its own condition ("only if the step is still
// older than this one", "only if the challenge still has tries and time left"). These are the races those conditions are for.
// The database here is the smallest thing that can show it: a read that always answers with the old state, and writes that
// apply their condition to the real current state, like Postgres does.
import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  lastStep: null as number | null,
  challenge: null as null | { id: string; userId: string; tokenHash: string; userAgent: string | null; remember: boolean; attempts: number; expiresAt: Date },
  deleted: 0,
}));

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: {
      // always the OLD state: no step used yet
      findUnique: async () => ({ totpSecret: `enc:${SECRET}`, totpEnabledAt: new Date("2026-11-18T09:00:00Z"), totpLastStep: null }),
      updateMany: async (a: any) => {
        const newer = a.data.totpLastStep;
        // every operator the code may use is understood, so a weaker condition is applied as written instead of never matching
        const holds = (w: any) => {
          const c = w.totpLastStep;
          if (c === null) return s.lastStep === null;
          if (s.lastStep === null) return false;
          return ("lt" in c ? s.lastStep < c.lt : true) && ("gt" in c ? s.lastStep > c.gt : true);
        };
        const matches = a.where.OR.some(holds);
        if (!matches) return { count: 0 };
        s.lastStep = newer;
        return { count: 1 };
      },
    },
    loginEvent: { count: async () => 0, create: async () => ({ id: "line" }), deleteMany: async () => ({ count: 1 }) },
    recoveryCode: { updateMany: async () => ({ count: 0 }) },
    totpChallenge: {
      // always the OLD state: not expired by the time the first request looked
      findUnique: async () => s.challenge,
      updateMany: async (a: any) => {
        const c = s.challenge;
        const alive = c && a.where.expiresAt.gt < c.expiresAt && c.attempts < a.where.attempts.lt;
        if (!alive) return { count: 0 };
        c.attempts += a.data.attempts.increment;
        return { count: 1 };
      },
      deleteMany: async () => {
        if (!s.challenge) return { count: 0 };
        s.challenge = null;
        s.deleted += 1;
        return { count: 1 };
      },
    },
  },
}));
vi.mock("../encryption.js", () => ({ encrypt: (x: string) => x, decrypt: (x: string) => x.replace(/^enc:/, "") }));

import { CHALLENGE_TTL_MS, answerChallenge, verifySecondFactor } from "./twoStep.js";
import { base32Decode, hotp, stepOf } from "../totp.js";
import { createHash } from "node:crypto";

const NOW = new Date("2026-11-18T10:00:30Z");
const code = hotp(base32Decode(SECRET), stepOf(NOW));

beforeEach(() => {
  s.lastStep = null;
  s.challenge = null;
  s.deleted = 0;
});

describe("the same code on two requests that both read the old state", () => {
  it("one is let in and the other is refused: the write only moves the used step forward", async () => {
    const results = await Promise.all([verifySecondFactor("u1", code, "ua", NOW), verifySecondFactor("u1", code, "ua", NOW)]);
    expect(results.sort()).toEqual(["ok", "wrong"]);
    expect(s.lastStep).toBe(stepOf(NOW));
  });

  it("ten at once: still exactly one", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => verifySecondFactor("u1", code, "ua", NOW)));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
  });

  it("a code for an older step cannot pull the used step back", async () => {
    s.lastStep = stepOf(NOW) + 5; // already ahead of the code's step, though the read above still says null
    expect(await verifySecondFactor("u1", code, "ua", NOW)).toBe("wrong");
    expect(s.lastStep).toBe(stepOf(NOW) + 5);
  });

  // The attack the condition exists for. The window accepts three steps. Request A carries the code of step N+1 and is let in
  // (the used step becomes N+1). Request B, which read the old state, carries the code of step N and would be let in if the write
  // only asked "is the step above zero": it would set the used step back to N, and the code of step N+1 would work a second time.
  it("an older code arriving after a newer one was used does not reopen the newer one", async () => {
    const newer = hotp(base32Decode(SECRET), stepOf(NOW) + 1);
    const older = hotp(base32Decode(SECRET), stepOf(NOW));
    expect(await verifySecondFactor("u1", newer, "ua", NOW)).toBe("ok");
    expect(s.lastStep).toBe(stepOf(NOW) + 1);
    expect(await verifySecondFactor("u1", older, "ua", NOW)).toBe("wrong"); // its step is not newer than the used one
    expect(s.lastStep).toBe(stepOf(NOW) + 1); // the record did not move back
    expect(await verifySecondFactor("u1", newer, "ua", NOW)).toBe("wrong"); // so the newer code is still spent
  });
});

describe("a challenge that is over or has no tries left", () => {
  const token = "a".repeat(64);
  const make = (patch: Partial<NonNullable<typeof s.challenge>> = {}) => {
    s.challenge = { id: "c1", userId: "u1", tokenHash: createHash("sha256").update(token).digest("hex"), userAgent: "ua", remember: true, attempts: 0, expiresAt: new Date(NOW.getTime() + 1000), ...patch };
  };

  it("one that is over is refused with the right code, and nothing is opened or deleted", async () => {
    make({ expiresAt: new Date(NOW.getTime() + 1000) });
    const later = new Date(NOW.getTime() + CHALLENGE_TTL_MS);
    expect((await answerChallenge(token, code, later)).result).toBe("expired");
    expect(s.challenge).not.toBeNull();
  });

  it("one whose tries ran out is refused with the right code", async () => {
    make({ attempts: 5 });
    expect((await answerChallenge(token, code, NOW)).result).toBe("expired");
    expect(s.challenge!.attempts).toBe(5);
  });

  it("the right code on a live challenge opens it, and only once", async () => {
    make();
    const results = await Promise.all([answerChallenge(token, code, NOW), answerChallenge(token, code, NOW)]);
    expect(results.filter((r) => r.result === "ok")).toHaveLength(1);
    expect(s.deleted).toBe(1);
  });
});
