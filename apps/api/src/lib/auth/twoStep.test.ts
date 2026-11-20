// What two-step verification allows, tried the way somebody who has the password would try it: guessing codes, guessing them
// in parallel, using a code twice, spending a recovery code twice, waiting too long. The database is a small fake that applies
// the `where` of each write like Postgres does (a conditional update only changes a row that still matches), because the
// guarantees live in those conditions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type User = { id: string; totpSecret: string | null; totpEnabledAt: Date | null; totpLastStep: number | null };
type Recovery = { id: string; userId: string; codeHash: string; usedAt: Date | null };
type Challenge = { id: string; userId: string; tokenHash: string; userAgent: string | null; remember: boolean; attempts: number; expiresAt: Date };
type Event = { userId: string; success: boolean; failure: string | null; at: Date };

const { db, table } = vi.hoisted(() => {
  const db = {
    users: [] as any[],
    recovery: [] as any[],
    challenges: [] as any[],
    events: [] as any[],
    seq: 0,
  };

  /** Does a row satisfy a Prisma `where` of the shapes this code uses? */
  function matches(row: Record<string, any>, where: Record<string, any> = {}): boolean {
    return Object.entries(where).every(([key, cond]) => {
      if (key === "OR") return (cond as any[]).some((w) => matches(row, w));
      const v = row[key];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        if ("lt" in cond && !(v !== null && v < cond.lt)) return false;
        if ("lte" in cond && !(v !== null && v <= cond.lte)) return false;
        if ("gt" in cond && !(v !== null && v > cond.gt)) return false;
        if ("gte" in cond && !(v !== null && v >= cond.gte)) return false;
        return true;
      }
      return cond === null ? v === null : v === cond || (cond instanceof Date && v instanceof Date && +v === +cond);
    });
  }

  function apply(row: Record<string, any>, data: Record<string, any>) {
    for (const [k, v] of Object.entries(data)) {
      row[k] = v !== null && typeof v === "object" && !(v instanceof Date) && "increment" in v ? row[k] + v.increment : v;
    }
  }

  const table = (rows: () => any[], set: (r: any[]) => void) => ({
    findUnique: async (a: { where: Record<string, any> }) => rows().find((r) => matches(r, a.where)) ?? null,
    findFirst: async (a: { where: Record<string, any> }) => rows().find((r) => matches(r, a.where)) ?? null,
    count: async (a: { where?: Record<string, any> } = {}) => rows().filter((r) => matches(r, a.where)).length,
    // the column defaults of schema.prisma: a row made without `attempts` starts at 0, and `remember` is on
    create: async (a: { data: Record<string, any> }) => {
      const r = { id: `r${++db.seq}`, attempts: 0, remember: true, usedAt: null, ...a.data };
      set([...rows(), r]);
      return r;
    },
    createMany: async (a: { data: Record<string, any>[] }) => {
      set([...rows(), ...a.data.map((d) => ({ id: `r${++db.seq}`, usedAt: null, ...d }))]);
      return { count: a.data.length };
    },
    update: async (a: { where: Record<string, any>; data: Record<string, any> }) => {
      const r = rows().find((x) => matches(x, a.where))!;
      apply(r, a.data);
      return r;
    },
    updateMany: async (a: { where: Record<string, any>; data: Record<string, any> }) => {
      const hit = rows().filter((r) => matches(r, a.where));
      hit.forEach((r) => apply(r, a.data));
      return { count: hit.length };
    },
    deleteMany: async (a: { where?: Record<string, any> } = {}) => {
      const hit = rows().filter((r) => matches(r, a.where));
      set(rows().filter((r) => !hit.includes(r)));
      return { count: hit.length };
    },
  });

  return { db, table };
});

vi.mock("../prisma.js", () => ({
  prisma: {
    user: table(() => db.users, (r) => (db.users = r)),
    recoveryCode: table(() => db.recovery, (r) => (db.recovery = r)),
    totpChallenge: table(() => db.challenges, (r) => (db.challenges = r)),
    loginEvent: {
      ...table(() => db.events, (r) => (db.events = r)),
      // a line gets its id and its time, and `select` is honoured: the code asks for the id to take the line back
      create: async (a: { data: Record<string, any>; select?: Record<string, boolean> }) => {
        // the fake clock of this file stands still, so the time is the one the test set
        const line = { id: `e${++db.seq}`, at: new Date(), ...a.data };
        db.events.push(line);
        return a.select ? Object.fromEntries(Object.keys(a.select).map((k) => [k, (line as any)[k]])) : line;
      },
    },
    $transaction: async (arg: any) => (typeof arg === "function" ? arg({ user: table(() => db.users, (r) => (db.users = r)), recoveryCode: table(() => db.recovery, (r) => (db.recovery = r)) }) : Promise.all(arg)),
  },
}));
// the encryption is not what is tested here; a visible marker is enough to see that the secret is stored encrypted
vi.mock("../encryption.js", () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, "") }));

import {
  ACCOUNT_MAX_WRONG,
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_TTL_MS,
  answerChallenge,
  beginSetup,
  createChallenge,
  finishSetup,
  newRecoveryCodes,
  turnOff,
  twoStepState,
  verifySecondFactor,
} from "./twoStep.js";
import { hashRecoveryCode, hotp, base32Decode, stepOf, verifyTotp } from "../totp.js";

const NOW = new Date("2026-11-18T10:00:30Z");
const codeAt = (secret: string, step: number) => hotp(base32Decode(secret), step);

/** A person with two-step on, as setup leaves them. */
async function personWithTwoStep() {
  db.users = [{ id: "u1", totpSecret: null, totpEnabledAt: null, totpLastStep: null }];
  const setup = (await beginSetup("u1", "puteri@example.com", "Postly"))!;
  const done = await finishSetup("u1", codeAt(setup.setupKey, stepOf(NOW)), NOW);
  if (done.result !== "ok") throw new Error("setup failed: " + done.result);
  return { secret: setup.setupKey, recoveryCodes: done.recoveryCodes };
}

const user = () => db.users[0] as User;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db.users = [];
  db.recovery = [];
  db.challenges = [];
  db.events = [];
  db.seq = 0;
});
afterEach(() => vi.useRealTimers());

describe("turning it on", () => {
  it("a secret is made and kept encrypted, but it does not count until a code from it is typed", async () => {
    db.users = [{ id: "u1", totpSecret: null, totpEnabledAt: null, totpLastStep: null }];
    const setup = (await beginSetup("u1", "puteri@example.com", "Postly"))!;
    expect(setup.setupKey).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUrl).toContain(`secret=${setup.setupKey}`);
    expect(user().totpSecret).toBe(`enc:${setup.setupKey}`); // stored encrypted, never as typed
    expect(user().totpEnabledAt).toBeNull();
    expect((await twoStepState("u1")).enabled).toBe(false);
  });

  it("the first right code switches it on and returns 8 recovery codes, which are stored only as hashes", async () => {
    const { recoveryCodes } = await personWithTwoStep();
    expect(user().totpEnabledAt).not.toBeNull();
    expect(recoveryCodes).toHaveLength(8);
    expect(new Set(recoveryCodes).size).toBe(8);
    expect(db.recovery).toHaveLength(8);
    expect(JSON.stringify(db.recovery)).not.toContain(recoveryCodes[0]);
    expect(db.recovery.map((r: Recovery) => r.codeHash)).toContain(hashRecoveryCode(recoveryCodes[0]));
    expect(await twoStepState("u1")).toMatchObject({ enabled: true, recoveryLeft: 8 });
  });

  it("a wrong first code switches nothing on and makes no recovery codes", async () => {
    db.users = [{ id: "u1", totpSecret: null, totpEnabledAt: null, totpLastStep: null }];
    await beginSetup("u1", "a@b.co", "Postly");
    expect((await finishSetup("u1", "000000", NOW)).result).toBe("wrong");
    expect(user().totpEnabledAt).toBeNull();
    expect(db.recovery).toHaveLength(0);
  });

  it("finishing without starting says so, and finishing twice is refused", async () => {
    db.users = [{ id: "u1", totpSecret: null, totpEnabledAt: null, totpLastStep: null }];
    expect((await finishSetup("u1", "123456", NOW)).result).toBe("not-started");
    await personWithTwoStep();
    expect((await finishSetup("u1", "123456", NOW)).result).toBe("already");
  });

  it("when it is already on, a second setup cannot swap the secret (a stolen session cannot replace the phone)", async () => {
    const { secret } = await personWithTwoStep();
    expect(await beginSetup("u1", "a@b.co", "Postly")).toBeNull();
    expect(user().totpSecret).toBe(`enc:${secret}`);
  });

  it("two people finishing at the same moment with the same secret switch it on once, with one set of recovery codes", async () => {
    db.users = [{ id: "u1", totpSecret: null, totpEnabledAt: null, totpLastStep: null }];
    const setup = (await beginSetup("u1", "a@b.co", "Postly"))!;
    const code = codeAt(setup.setupKey, stepOf(NOW));
    const results = await Promise.all([finishSetup("u1", code, NOW), finishSetup("u1", code, NOW)]);
    expect(results.filter((r) => r.result === "ok")).toHaveLength(1);
    expect(db.recovery).toHaveLength(8);
  });
});

describe("the code", () => {
  it("the code of this moment is accepted", async () => {
    const { secret } = await personWithTwoStep();
    // the step used to switch it on is spent; the next step's code is fresh
    expect(await verifySecondFactor("u1", codeAt(secret, stepOf(NOW) + 1), "ua", NOW)).toBe("ok");
  });

  it("a code cannot be used twice: the same step is refused the second time", async () => {
    const { secret } = await personWithTwoStep();
    const code = codeAt(secret, stepOf(NOW) + 1);
    expect(await verifySecondFactor("u1", code, "ua", NOW)).toBe("ok");
    expect(await verifySecondFactor("u1", code, "ua", NOW)).toBe("wrong");
  });

  it("the write that records a step moves only forward: a code for an older step cannot pull it back and be used again", async () => {
    const { secret } = await personWithTwoStep();
    const stepNow = stepOf(NOW);
    // the newest used step is already ahead of the step this code belongs to, yet the code is inside the time window
    user().totpLastStep = stepNow + 5;
    expect(await verifySecondFactor("u1", codeAt(secret, stepNow + 1), "ua", NOW)).toBe("wrong");
    expect(user().totpLastStep).toBe(stepNow + 5); // and the record did not move back
  });

  it("the code that switched it on cannot be used to log in right after", async () => {
    const { secret } = await personWithTwoStep();
    expect(await verifySecondFactor("u1", codeAt(secret, stepOf(NOW)), "ua", NOW)).toBe("wrong");
  });

  it("the same code sent twice at the same moment is accepted once", async () => {
    const { secret } = await personWithTwoStep();
    const code = codeAt(secret, stepOf(NOW) + 1);
    const results = await Promise.all([verifySecondFactor("u1", code, "ua", NOW), verifySecondFactor("u1", code, "ua", NOW), verifySecondFactor("u1", code, "ua", NOW)]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
  });

  // Two requests read the account BEFORE either writes: both see the same old step, so the check made on what was read cannot
  // tell them apart. Only the write, which carries its own condition, can: this is the race the condition is there for.
  it("the same code on two requests that both read the old state: the write lets one through and refuses the other", async () => {
    const { secret } = await personWithTwoStep();
    const code = codeAt(secret, stepOf(NOW) + 1);
    const realFind = (await import("../prisma.js")).prisma.user.findUnique;
    const stale = await realFind({ where: { id: "u1" } }); // what both requests read: no step used yet beyond setup
    const spy = vi.spyOn((await import("../prisma.js")).prisma.user, "findUnique").mockResolvedValue(stale as never);
    try {
      const results = await Promise.all([verifySecondFactor("u1", code, "ua", NOW), verifySecondFactor("u1", code, "ua", NOW)]);
      expect(results.filter((r) => r === "ok")).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a wrong code is refused and written to the person's sign-in history", async () => {
    await personWithTwoStep();
    expect(await verifySecondFactor("u1", "000000", "Mozilla/5.0 test", NOW)).toBe("wrong");
    expect(db.events).toEqual([expect.objectContaining({ userId: "u1", success: false, failure: "Wrong two-step code" })]);
  });

  it("after 10 wrong codes in 15 minutes even the right code is refused: the account is locked for guessing", async () => {
    const { secret } = await personWithTwoStep();
    for (let i = 0; i < ACCOUNT_MAX_WRONG; i++) expect(await verifySecondFactor("u1", "000000", "ua", NOW)).toBe("wrong");
    expect(await verifySecondFactor("u1", codeAt(secret, stepOf(NOW) + 1), "ua", NOW)).toBe("locked");
    // 15 minutes later the lock has gone
    const later = new Date(NOW.getTime() + 16 * 60 * 1000);
    expect(await verifySecondFactor("u1", codeAt(secret, stepOf(later)), "ua", later)).toBe("ok");
  });

  // The lock counts the wrong-code lines. A guess is written BEFORE it is checked and counted together with itself, so a burst sent
  // at one moment cannot all pass the same count. At most ACCOUNT_MAX_WRONG guesses are ever looked at; the others are "locked"
  // without their code being read. (Counting after the check let a whole burst through, since none of them had been written yet.)
  it("12 wrong guesses one after the other: the first 10 are answered wrong, then the account is locked", async () => {
    await personWithTwoStep();
    const results: string[] = [];
    for (let i = 0; i < 12; i++) results.push(await verifySecondFactor("u1", String(100000 + i), "ua", NOW));
    expect(results.slice(0, ACCOUNT_MAX_WRONG).every((r) => r === "wrong")).toBe(true);
    expect(results.slice(ACCOUNT_MAX_WRONG)).toEqual(["locked", "locked"]);
  });

  // A guess the lock refuses takes its own line back, so a burst that all counts the same total refuses every one of its guesses
  // and leaves no lines. What must hold is that no more than ACCOUNT_MAX_WRONG guesses are LOOKED AT in the window, however many
  // bursts are sent: the lines of the guesses that were looked at stay.
  it("50 wrong guesses sent at the same moment, again and again: no more than 10 of them are ever looked at", async () => {
    await personWithTwoStep();
    let looked = 0;
    for (let burst = 0; burst < 4; burst++) {
      const results = await Promise.all(Array.from({ length: 50 }, (_, i) => verifySecondFactor("u1", String(100000 + burst * 100 + i), "ua", NOW)));
      looked += results.filter((r) => r === "wrong").length;
      expect(results.filter((r) => r === "ok")).toHaveLength(0);
    }
    expect(looked).toBeLessThanOrEqual(ACCOUNT_MAX_WRONG);
    expect(db.events.length).toBeLessThanOrEqual(ACCOUNT_MAX_WRONG); // the lines left are those of the guesses that were looked at
  });

  it("a burst that includes the right code does not get it through once the lock is reached", async () => {
    const { secret } = await personWithTwoStep();
    for (let i = 0; i < ACCOUNT_MAX_WRONG; i++) await verifySecondFactor("u1", "000000", "ua", NOW);
    const burst = [codeAt(secret, stepOf(NOW) + 1), ...Array.from({ length: 20 }, (_, i) => String(200000 + i))];
    const results = await Promise.all(burst.map((c) => verifySecondFactor("u1", c, "ua", NOW)));
    expect(results.every((r) => r === "locked")).toBe(true);
  });

  // The lock must end 15 minutes after the guesses that caused it. An attempt the lock refuses used to leave its own line, so a
  // person (or a script) that kept trying while locked kept pushing the end of the lock forward, and the message said 15 minutes.
  it("trying again while locked leaves no line behind: the lock still ends 15 minutes after the guesses that made it", async () => {
    const { secret } = await personWithTwoStep();
    for (let i = 0; i < ACCOUNT_MAX_WRONG; i++) await verifySecondFactor("u1", "000000", "ua", NOW);
    expect(db.events).toHaveLength(ACCOUNT_MAX_WRONG);

    const retry = new Date(NOW.getTime() + 5 * 60 * 1000);
    vi.setSystemTime(retry);
    for (let i = 0; i < 12; i++) expect(await verifySecondFactor("u1", "000000", "ua", retry)).toBe("locked");
    expect(db.events).toHaveLength(ACCOUNT_MAX_WRONG); // the twelve refused attempts wrote nothing that stays

    const later = new Date(NOW.getTime() + 16 * 60 * 1000);
    vi.setSystemTime(later);
    expect(await verifySecondFactor("u1", codeAt(secret, stepOf(later)), "ua", later)).toBe("ok");
  });

  // Somebody who knows the password can make a challenge and send 10 wrong codes. That must not shut the owner out: the lock is for
  // the 6 digits, and a recovery code (about 49 bits, 8 of them) cannot be guessed.
  it("while the 6 digits are locked a recovery code still gets the owner in, once", async () => {
    const { secret, recoveryCodes } = await personWithTwoStep();
    for (let i = 0; i < ACCOUNT_MAX_WRONG; i++) await verifySecondFactor("u1", "000000", "ua", NOW);
    expect(await verifySecondFactor("u1", codeAt(secret, stepOf(NOW) + 1), "ua", NOW)).toBe("locked"); // the right 6 digits are still refused
    expect(await verifySecondFactor("u1", recoveryCodes[0], "ua", NOW)).toBe("ok");
    expect(await verifySecondFactor("u1", recoveryCodes[0], "ua", NOW)).toBe("wrong"); // spent
  });

  it("a wrong recovery code during the lock is just wrong, and is not a way to guess the 6 digits", async () => {
    await personWithTwoStep();
    for (let i = 0; i < ACCOUNT_MAX_WRONG; i++) await verifySecondFactor("u1", "000000", "ua", NOW);
    expect(await verifySecondFactor("u1", "AAAAA-BBBBB", "ua", NOW)).toBe("wrong");
  });

  it("a right code does not use up the allowance: signing in 30 times in a row never locks the account", async () => {
    const { secret } = await personWithTwoStep();
    for (let i = 1; i <= 30; i++) {
      const at = new Date(NOW.getTime() + i * 31_000); // a new 30-second step each time
      expect(await verifySecondFactor("u1", codeAt(secret, stepOf(at)), "ua", at)).toBe("ok");
    }
    expect(db.events.filter((e: Event) => e.failure === "Wrong two-step code")).toHaveLength(0);
  });

  it("a wrong code leaves exactly one line behind, a right one none", async () => {
    const { secret } = await personWithTwoStep();
    await verifySecondFactor("u1", "000000", "ua", NOW);
    expect(db.events).toHaveLength(1);
    await verifySecondFactor("u1", codeAt(secret, stepOf(NOW) + 1), "ua", NOW);
    expect(db.events).toHaveLength(1); // the right code's own line was taken back
  });

  it("an account without two-step has nothing to pass: a code is simply wrong", async () => {
    db.users = [{ id: "u1", totpSecret: null, totpEnabledAt: null, totpLastStep: null }];
    expect(await verifySecondFactor("u1", "123456", "ua", NOW)).toBe("wrong");
  });
});

describe("recovery codes", () => {
  it("one works, once", async () => {
    const { recoveryCodes } = await personWithTwoStep();
    expect(await verifySecondFactor("u1", recoveryCodes[0], "ua", NOW)).toBe("ok");
    expect(await verifySecondFactor("u1", recoveryCodes[0], "ua", NOW)).toBe("wrong");
    expect((await twoStepState("u1")).recoveryLeft).toBe(7);
  });

  it("is accepted however it is typed: lower case, without the dash", async () => {
    const { recoveryCodes } = await personWithTwoStep();
    expect(await verifySecondFactor("u1", recoveryCodes[1].toLowerCase().replace("-", " "), "ua", NOW)).toBe("ok");
  });

  it("the same one sent twice at the same moment is spent once", async () => {
    const { recoveryCodes } = await personWithTwoStep();
    const results = await Promise.all([verifySecondFactor("u1", recoveryCodes[2], "ua", NOW), verifySecondFactor("u1", recoveryCodes[2], "ua", NOW)]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
  });

  it("another person's recovery code does not work for this person", async () => {
    const { recoveryCodes } = await personWithTwoStep();
    db.users.push({ id: "u2", totpSecret: "enc:JBSWY3DPEHPK3PXP", totpEnabledAt: NOW, totpLastStep: null });
    expect(await verifySecondFactor("u2", recoveryCodes[0], "ua", NOW)).toBe("wrong");
    expect((await twoStepState("u1")).recoveryLeft).toBe(8); // and it was not spent
  });

  it("new codes replace the old: the old ones stop working", async () => {
    const { recoveryCodes } = await personWithTwoStep();
    const fresh = await newRecoveryCodes("u1");
    expect(fresh).toHaveLength(8);
    expect(await verifySecondFactor("u1", recoveryCodes[0], "ua", NOW)).toBe("wrong");
    expect(await verifySecondFactor("u1", fresh[0], "ua", NOW)).toBe("ok");
  });

  it("turning it off removes the secret and every recovery code", async () => {
    await personWithTwoStep();
    await turnOff("u1");
    expect(user()).toMatchObject({ totpSecret: null, totpEnabledAt: null, totpLastStep: null });
    expect(db.recovery).toHaveLength(0);
  });
});

describe("a login waiting for its code", () => {
  const challengeFor = (remember = true) => createChallenge("u1", "ua", remember, NOW);

  it("keeps only a hash of its token", async () => {
    await personWithTwoStep();
    const token = await challengeFor();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(db.challenges)).not.toContain(token);
    expect(db.challenges[0].expiresAt.getTime()).toBe(NOW.getTime() + CHALLENGE_TTL_MS);
  });

  it("the right code opens it once: the answer names the person, and the challenge is gone", async () => {
    const { secret } = await personWithTwoStep();
    const token = await challengeFor(false);
    const answer = await answerChallenge(token, codeAt(secret, stepOf(NOW) + 1), NOW);
    expect(answer).toEqual({ result: "ok", userId: "u1", userAgent: "ua", remember: false });
    expect(db.challenges).toHaveLength(0);
    expect((await answerChallenge(token, codeAt(secret, stepOf(NOW) + 1), NOW)).result).toBe("expired");
  });

  it("a wrong code is refused and the challenge stays, with one try used", async () => {
    await personWithTwoStep();
    const token = await challengeFor();
    expect((await answerChallenge(token, "000000", NOW)).result).toBe("wrong");
    expect(db.challenges[0].attempts).toBe(1);
  });

  it("after 5 wrong codes the challenge is spent: even the right code no longer opens it", async () => {
    const { secret } = await personWithTwoStep();
    const token = await challengeFor();
    for (let i = 0; i < CHALLENGE_MAX_ATTEMPTS; i++) expect((await answerChallenge(token, "000000", NOW)).result).toBe("wrong");
    expect((await answerChallenge(token, codeAt(secret, stepOf(NOW) + 1), NOW)).result).toBe("expired");
  });

  it("50 guesses sent at the same moment still get only 5 tries (the try is counted before the code is looked at)", async () => {
    const { secret } = await personWithTwoStep();
    const token = await challengeFor();
    const guesses = Array.from({ length: 50 }, (_, i) => answerChallenge(token, String(100000 + i), NOW));
    const results = await Promise.all(guesses);
    expect(results.filter((r) => r.result === "wrong")).toHaveLength(CHALLENGE_MAX_ATTEMPTS);
    expect(results.filter((r) => r.result === "expired")).toHaveLength(50 - CHALLENGE_MAX_ATTEMPTS);
    expect((await answerChallenge(token, codeAt(secret, stepOf(NOW) + 1), NOW)).result).toBe("expired");
  });

  it("the right code sent twice at the same moment opens one session, not two", async () => {
    const { secret } = await personWithTwoStep();
    const token = await challengeFor();
    const code = codeAt(secret, stepOf(NOW) + 1);
    const results = await Promise.all([answerChallenge(token, code, NOW), answerChallenge(token, code, NOW)]);
    expect(results.filter((r) => r.result === "ok")).toHaveLength(1);
  });

  it("after 5 minutes it is expired even for the right code, and one that never existed says the same", async () => {
    const { secret } = await personWithTwoStep();
    const token = await challengeFor();
    const late = new Date(NOW.getTime() + CHALLENGE_TTL_MS + 1000);
    // the code is right for the moment it is typed: only the age of the challenge can refuse it
    expect(verifyTotp(secret, codeAt(secret, stepOf(late)), late, user().totpLastStep)).not.toBeNull();
    expect((await answerChallenge(token, codeAt(secret, stepOf(late)), late)).result).toBe("expired");
    expect(db.challenges).toHaveLength(1); // and it did not open, or spend, anything
    expect((await answerChallenge("f".repeat(64), "123456", NOW)).result).toBe("expired");
  });

  it("exactly at the 5 minutes it is over, a second before it is not", async () => {
    const { secret } = await personWithTwoStep();
    const token = await challengeFor();
    const atEdge = new Date(NOW.getTime() + CHALLENGE_TTL_MS);
    expect((await answerChallenge(token, codeAt(secret, stepOf(atEdge)), atEdge)).result).toBe("expired");
    const justBefore = new Date(NOW.getTime() + CHALLENGE_TTL_MS - 1000);
    expect((await answerChallenge(token, codeAt(secret, stepOf(justBefore)), justBefore)).result).toBe("ok");
  });

  it("a challenge cannot be answered with another person's code", async () => {
    await personWithTwoStep();
    const other = { id: "u2", totpSecret: "enc:JBSWY3DPEHPK3PXP", totpEnabledAt: NOW, totpLastStep: null };
    db.users.push(other);
    const token = await challengeFor(); // u1's
    const otherCode = codeAt("JBSWY3DPEHPK3PXP", stepOf(NOW));
    expect((await answerChallenge(token, otherCode, NOW)).result).toBe("wrong");
  });

  it("making a new challenge clears the ones that have run out", async () => {
    await personWithTwoStep();
    db.challenges.push({ id: "old", userId: "u1", tokenHash: "x", userAgent: null, remember: true, attempts: 0, expiresAt: new Date(NOW.getTime() - 1000) });
    await challengeFor();
    expect(db.challenges.map((c: Challenge) => c.id)).not.toContain("old");
  });

  // Each password login (the password is all it takes) makes a challenge. If they piled up, so would the tries.
  it("one challenge is alive per person: a new login replaces the old one, so the tries do not add up", async () => {
    const { secret } = await personWithTwoStep();
    const first = await challengeFor();
    for (let i = 0; i < 4; i++) await answerChallenge(first, "000000", NOW); // 4 of its 5 tries used
    const second = await challengeFor();
    expect(db.challenges).toHaveLength(1);
    expect((await answerChallenge(first, codeAt(secret, stepOf(NOW) + 1), NOW)).result).toBe("expired"); // the old one is gone
    expect((await answerChallenge(second, codeAt(secret, stepOf(NOW) + 1), NOW)).result).toBe("ok");
  });

  it("another person's challenge is not touched when this person logs in", async () => {
    await personWithTwoStep();
    db.challenges.push({ id: "other", userId: "u2", tokenHash: "y", userAgent: null, remember: true, attempts: 0, expiresAt: new Date(NOW.getTime() + 60_000) });
    await challengeFor();
    expect(db.challenges.map((c: Challenge) => c.id)).toContain("other");
  });
});
