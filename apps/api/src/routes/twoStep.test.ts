// What the browser sees of two-step verification: setup, the login that stops at a challenge, and the two actions that need
// the password AND a code. The rules themselves (tries, replay, recovery codes) are tested in lib/auth/twoStep.test.ts;
// here the library is real and only the database is replaced, so a route cannot skip a rule without a test noticing.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { db, table } = vi.hoisted(() => {
  const db = { users: [] as any[], recovery: [] as any[], challenges: [] as any[], events: [] as any[], seq: 0, revoked: [] as Array<[string, string | undefined]> };
  function matches(row: Record<string, any>, where: Record<string, any> = {}): boolean {
    return Object.entries(where).every(([key, cond]) => {
      if (key === "OR") return (cond as any[]).some((w) => matches(row, w));
      const v = row[key];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        if ("lt" in cond && !(v !== null && v < cond.lt)) return false;
        if ("gt" in cond && !(v !== null && v > cond.gt)) return false;
        if ("gte" in cond && !(v !== null && v >= cond.gte)) return false;
        return true;
      }
      return cond === null ? v === null : v === cond;
    });
  }
  const apply = (row: any, data: any) => {
    for (const [k, v] of Object.entries<any>(data)) row[k] = v !== null && typeof v === "object" && !(v instanceof Date) && "increment" in v ? row[k] + v.increment : v;
  };
  // `select` is honoured like Prisma does: only the named columns come back, so a route that forgets one is what the test sees
  const pick = (row: any, select?: Record<string, boolean>) => {
    if (!row || !select) return row ?? null;
    return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
  };
  const table = (rows: () => any[], set: (r: any[]) => void) => ({
    findUnique: async (a: any) => pick(rows().find((r) => matches(r, a.where)), a.select),
    count: async (a: any = {}) => rows().filter((r) => matches(r, a.where)).length,
    create: async (a: any) => {
      const r = { id: `r${++db.seq}`, attempts: 0, remember: true, usedAt: null, at: new Date(), ...a.data };
      set([...rows(), r]);
      return r;
    },
    createMany: async (a: any) => (set([...rows(), ...a.data.map((d: any) => ({ id: `r${++db.seq}`, usedAt: null, ...d }))]), { count: a.data.length }),
    update: async (a: any) => {
      const r = rows().find((x) => matches(x, a.where))!;
      apply(r, a.data);
      return r;
    },
    updateMany: async (a: any) => {
      const hit = rows().filter((r) => matches(r, a.where));
      hit.forEach((r) => apply(r, a.data));
      return { count: hit.length };
    },
    deleteMany: async (a: any = {}) => {
      const hit = rows().filter((r) => matches(r, a.where));
      set(rows().filter((r) => !hit.includes(r)));
      return { count: hit.length };
    },
  });
  return { db, table };
});

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: table(() => db.users, (r) => (db.users = r)),
    recoveryCode: table(() => db.recovery, (r) => (db.recovery = r)),
    totpChallenge: table(() => db.challenges, (r) => (db.challenges = r)),
    loginEvent: table(() => db.events, (r) => (db.events = r)),
    $transaction: async (arg: any) => (typeof arg === "function" ? arg({ user: table(() => db.users, (r) => (db.users = r)), recoveryCode: table(() => db.recovery, (r) => (db.recovery = r)) }) : Promise.all(arg)),
  },
}));
vi.mock("../lib/encryption.js", () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, "") }));
vi.mock("../lib/auth/index.js", () => ({
  authProvider: { revokeOtherSessions: async (userId: string, keep?: string) => void db.revoked.push([userId, keep]) },
}));
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async () => {},
  getUser: () => ({ id: "u1" }),
  setAuthCookies: (reply: any, access: string, refresh: string, o: { persistent?: boolean }) => {
    reply.header("x-test-session", `${access}|${refresh}|persistent=${o.persistent}`);
  },
}));
vi.mock("../lib/auth/localAuth.js", () => ({
  createLocalTokens: async (userId: string, ua: string | null) => ({ accessToken: `access-${userId}`, refreshToken: `refresh-${ua}` }),
}));

import { twoStepRoutes } from "./twoStep.js";
import { createChallenge, beginSetup, finishSetup } from "../lib/auth/twoStep.js";
import { base32Decode, hotp, stepOf } from "../lib/totp.js";

let app: FastifyInstance;
const NOW = new Date("2026-11-18T10:00:30Z");
const codeAt = (secret: string, step: number) => hotp(base32Decode(secret), step);
const PASSWORD = "Password123";

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  app = Fastify();
  await app.register(cookie);
  await app.register(twoStepRoutes);
  await app.ready();
});
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
});
beforeEach(async () => {
  db.users = [{ id: "u1", email: "puteri@example.com", passwordHash: await bcrypt.hash(PASSWORD, 4), totpSecret: null, totpEnabledAt: null, totpLastStep: null }];
  db.recovery = [];
  db.challenges = [];
  db.events = [];
  db.revoked = [];
  db.seq = 0;
});

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });

async function turnedOn() {
  const setup = (await beginSetup("u1", "puteri@example.com", "Postly"))!;
  const done = await finishSetup("u1", codeAt(setup.setupKey, stepOf(NOW)), NOW);
  if (done.result !== "ok") throw new Error("setup failed");
  return { secret: setup.setupKey, recoveryCodes: done.recoveryCodes };
}
/** A code the way the phone shows it a moment after setup: the next 30-second step, so it is not the one setup spent. */
const freshCode = (secret: string, ahead = 1) => codeAt(secret, stepOf(NOW) + ahead);

describe("GET /user/two-step", () => {
  it("says it is off, with nothing in it that could be a secret", async () => {
    const res = await app.inject({ method: "GET", url: "/user/two-step" });
    expect(res.json()).toEqual({ enabled: false, enabledAt: null, recoveryLeft: 0, available: true });
  });

  it("says it is on, when, and how many recovery codes are left", async () => {
    await turnedOn();
    const body = (await app.inject({ method: "GET", url: "/user/two-step" })).json();
    expect(body).toMatchObject({ enabled: true, recoveryLeft: 8, available: true });
    expect(body.enabledAt).toBe(NOW.toISOString());
    expect(JSON.stringify(body)).not.toMatch(/secret|enc:|[A-Z2-7]{32}/i);
  });

  it("an account that signs in with Google or LinkedIn has no password here, so it is not available", async () => {
    db.users[0].passwordHash = null;
    expect((await app.inject({ method: "GET", url: "/user/two-step" })).json().available).toBe(false);
  });
});

describe("turning it on", () => {
  it("start gives the key to type and the address to scan; enable with the right code switches it on and signs the other devices out", async () => {
    const start = (await post("/user/two-step/start", {})).json();
    expect(start.setupKey).toMatch(/^[A-Z2-7]{32}$/);
    expect(start.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Posthive:puteri%40example\.com\?secret=/);

    const res = await post("/user/two-step/enable", { password: PASSWORD, code: codeAt(start.setupKey, stepOf(NOW)) });
    expect(res.statusCode).toBe(200);
    expect(res.json().recoveryCodes).toHaveLength(8);
    expect(db.users[0].totpEnabledAt).not.toBeNull();
    expect(db.revoked).toEqual([["u1", undefined]]);
  });

  it("a wrong first code answers in words and switches nothing on", async () => {
    await post("/user/two-step/start", {});
    const res = await post("/user/two-step/enable", { password: PASSWORD, code: "000000" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "That code isn't right. Check your app and try again.", code: "WRONG_CODE" });
    expect(db.users[0].totpEnabledAt).toBeNull();
    expect(db.revoked).toEqual([]);
  });

  it("enable before start says to start again", async () => {
    const res = await post("/user/two-step/enable", { password: PASSWORD, code: "123456" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("NOT_STARTED");
  });

  it("start when it is already on is refused, and the secret is the same as before", async () => {
    const { secret } = await turnedOn();
    const res = await post("/user/two-step/start", {});
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("ALREADY_ON");
    expect(db.users[0].totpSecret).toBe(`enc:${secret}`);
  });

  it("an account with no password (Google, LinkedIn) is told why it cannot", async () => {
    db.users[0].passwordHash = null;
    const res = await post("/user/two-step/start", {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "NO_PASSWORD" });
  });

  it("a code that is not even a code is refused before anything is checked", async () => {
    expect((await post("/user/two-step/enable", { password: PASSWORD, code: "1" })).statusCode).toBe(400);
    expect((await post("/user/two-step/enable", {})).statusCode).toBe(400);
  });

  // A stolen session cookie is not the password. Without this check it could put its own phone on the account, and the sign-out
  // of the other devices that follows would lock the real owner out.
  it("a session without the password cannot turn it on: the right code alone is refused and nothing changes", async () => {
    const start = (await post("/user/two-step/start", {})).json();
    const code = codeAt(start.setupKey, stepOf(NOW));
    const noPassword = await post("/user/two-step/enable", { code });
    expect(noPassword.statusCode).toBe(400);
    const wrongPassword = await post("/user/two-step/enable", { password: "not the password", code });
    expect(wrongPassword.statusCode).toBe(400);
    expect(wrongPassword.json().code).toBe("WRONG_PASSWORD");
    expect(db.users[0].totpEnabledAt).toBeNull();
    expect(db.recovery).toHaveLength(0);
    expect(db.revoked).toEqual([]); // the owner was not signed out
  });

  it("a wrong password does not use up the setup: the right password and code still work afterwards", async () => {
    const start = (await post("/user/two-step/start", {})).json();
    const code = codeAt(start.setupKey, stepOf(NOW));
    await post("/user/two-step/enable", { password: "wrong", code });
    expect((await post("/user/two-step/enable", { password: PASSWORD, code })).statusCode).toBe(200);
  });
});

describe("the second step of a login", () => {
  const login = (challenge: string, code: string) => post("/auth/login/two-step", { challenge, code });

  it("the right code opens the session, with the browser the password was typed in and the person's choice to be remembered", async () => {
    const { secret } = await turnedOn();
    const challenge = await createChallenge("u1", "Firefox on Linux", false, NOW);
    db.users[0].name = "Puteri";
    const res = await login(challenge, freshCode(secret));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-test-session"]).toBe("access-u1|refresh-Firefox on Linux|persistent=false");
    expect(res.json().user).toMatchObject({ id: "u1", email: "puteri@example.com" });
    expect(JSON.stringify(res.json())).not.toMatch(/passwordHash|totp|enc:/);
  });

  it("a wrong code is 401 with words, opens no session, and leaves the challenge for another try", async () => {
    await turnedOn();
    const challenge = await createChallenge("u1", "ua", true, NOW);
    const res = await login(challenge, "000000");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "That code isn't right. Check your app and try again.", code: "WRONG_CODE" });
    expect(res.headers["x-test-session"]).toBeUndefined();
    expect(db.challenges).toHaveLength(1);
  });

  it("a recovery code opens the session too, once", async () => {
    const { recoveryCodes } = await turnedOn();
    const first = await createChallenge("u1", "ua", true, NOW);
    expect((await login(first, recoveryCodes[0])).statusCode).toBe(200);
    const second = await createChallenge("u1", "ua", true, NOW);
    expect((await login(second, recoveryCodes[0])).statusCode).toBe(401);
  });

  it("5 wrong codes use the challenge up: the right code then says to start over from the password", async () => {
    const { secret } = await turnedOn();
    const challenge = await createChallenge("u1", "ua", true, NOW);
    for (let i = 0; i < 5; i++) expect((await login(challenge, "000000")).statusCode).toBe(401);
    const res = await login(challenge, freshCode(secret));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "That sign-in took too long. Enter your email and password again.", code: "CHALLENGE_EXPIRED" });
    expect(res.headers["x-test-session"]).toBeUndefined();
  });

  it("a challenge that never existed, or has the wrong shape, opens nothing", async () => {
    await turnedOn();
    expect((await login("f".repeat(64), "123456")).statusCode).toBe(401);
    expect((await login("short", "123456")).statusCode).toBe(400);
    expect((await post("/auth/login/two-step", { code: "123456" })).statusCode).toBe(400);
  });

  it("the same right code used at once on one challenge opens one session", async () => {
    const { secret } = await turnedOn();
    const challenge = await createChallenge("u1", "ua", true, NOW);
    const code = freshCode(secret);
    const results = await Promise.all([login(challenge, code), login(challenge, code), login(challenge, code)]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });
});

describe("turning it off and making new recovery codes need the password AND a code", () => {
  it("turns it off with both, and removes everything it kept", async () => {
    const { secret } = await turnedOn();
    const res = await post("/user/two-step/disable", { password: PASSWORD, code: freshCode(secret) });
    expect(res.statusCode).toBe(200);
    expect(db.users[0]).toMatchObject({ totpSecret: null, totpEnabledAt: null });
    expect(db.recovery).toHaveLength(0);
  });

  it("a wrong password is refused, and the code is not even looked at", async () => {
    const { secret } = await turnedOn();
    const res = await post("/user/two-step/disable", { password: "not the password", code: freshCode(secret) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("WRONG_PASSWORD");
    expect(db.users[0].totpEnabledAt).not.toBeNull();
    expect(db.events).toHaveLength(0);
  });

  it("the right password with a wrong code is refused and written to the sign-in history", async () => {
    await turnedOn();
    const res = await post("/user/two-step/disable", { password: PASSWORD, code: "000000" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("WRONG_CODE");
    expect(db.users[0].totpEnabledAt).not.toBeNull();
    expect(db.events.map((e: any) => e.failure)).toEqual(["Wrong two-step code"]);
  });

  it("a recovery code counts as the code (a lost phone must still be able to turn it off)", async () => {
    const { recoveryCodes } = await turnedOn();
    expect((await post("/user/two-step/disable", { password: PASSWORD, code: recoveryCodes[3] })).statusCode).toBe(200);
  });

  it("when it is not on there is nothing to turn off", async () => {
    const res = await post("/user/two-step/disable", { password: PASSWORD, code: "123456" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("NOT_ON");
  });

  it("new recovery codes: with both, eight arrive and the old ones stop working", async () => {
    const { secret, recoveryCodes } = await turnedOn();
    const res = await post("/user/two-step/recovery-codes", { password: PASSWORD, code: freshCode(secret) });
    expect(res.statusCode).toBe(200);
    const fresh = res.json().recoveryCodes as string[];
    expect(fresh).toHaveLength(8);
    expect(fresh).not.toContain(recoveryCodes[0]);
    const challenge = await createChallenge("u1", "ua", true, NOW);
    expect((await post("/auth/login/two-step", { challenge, code: recoveryCodes[0] })).statusCode).toBe(401);
  });

  it("new recovery codes without the password are refused", async () => {
    const { secret } = await turnedOn();
    const res = await post("/user/two-step/recovery-codes", { code: freshCode(secret) });
    expect(res.statusCode).toBe(400);
  });
});
