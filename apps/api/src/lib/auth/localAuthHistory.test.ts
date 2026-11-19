// Signing in leaves a line of history and a session that knows its browser; a wrong password leaves a line only when
// the email is a real account. The password and the database are faked; what is checked is who is written and what is not.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; name: string; avatarUrl: null; timezone: string; passwordHash: string | null; totpEnabledAt?: Date | null },
  valid: true,
  events: [] as any[],
  sessions: [] as any[],
  eventsFail: false,
  // localAuth reads the secret when it is loaded, which is before any line of this file runs
  secret: (process.env.JWT_ACCESS_SECRET = "test-secret"),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => h.user), create: vi.fn(), update: vi.fn() },
    workspace: { create: vi.fn(async () => ({ id: "ws" })) },
    loginEvent: {
      create: vi.fn(async (a: any) => {
        if (h.eventsFail) throw new Error("db down");
        h.events.push(a.data);
        return {};
      }),
    },
    authSession: { create: vi.fn(async (a: any) => { h.sessions.push(a.data); return { id: "sess-1", ...a.data }; }) },
  },
}));
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn(async () => h.valid), hash: vi.fn(async () => "hash") } }));

import { createLocalTokens, localAuthProvider } from "./localAuth.js";

const USER = { id: "u1", email: "a@b.co", name: "A", avatarUrl: null, timezone: "UTC", passwordHash: "x" };
const CHROME = "Mozilla/5.0 (Macintosh) Chrome/130.0.0.0 Safari/537";

beforeEach(() => {
  h.user = { ...USER };
  h.valid = true;
  h.events = [];
  h.sessions = [];
  h.eventsFail = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("login with two-step verification on", () => {
  beforeEach(() => {
    h.user = { ...USER, totpEnabledAt: new Date("2026-11-18T03:00:00Z") };
  });

  it("the right password alone opens NO session: the answer says a code is needed, and names the person for the challenge", async () => {
    const result = await localAuthProvider.login("a@b.co", "pw", CHROME);
    expect(result).toEqual({ twoStepRequired: true, userId: "u1" });
    expect(result).not.toHaveProperty("accessToken");
    expect(result).not.toHaveProperty("refreshToken");
    expect(h.sessions).toHaveLength(0);
  });

  it("nothing is written to the sign-in history yet: a sign-in is recorded when a session opens, after the code", async () => {
    await localAuthProvider.login("a@b.co", "pw", CHROME);
    expect(h.events).toHaveLength(0);
  });

  it("a wrong password is still a wrong password: the same message, the same line, and no hint that two-step is on", async () => {
    h.valid = false;
    await expect(localAuthProvider.login("a@b.co", "bad", CHROME)).rejects.toThrow("Invalid email or password");
    expect(h.events).toEqual([{ userId: "u1", userAgent: CHROME, success: false, failure: "Wrong password" }]);
  });

  it("an account whose two-step was turned off signs in with the password alone, as before", async () => {
    h.user = { ...USER, totpEnabledAt: null };
    expect(await localAuthProvider.login("a@b.co", "pw", CHROME)).toHaveProperty("accessToken");
    expect(h.sessions).toHaveLength(1);
  });
});

describe("login", () => {
  it("a good password opens a session that remembers the browser, and writes a successful line", async () => {
    await localAuthProvider.login("a@b.co", "pw", CHROME);
    expect(h.sessions[0]).toMatchObject({ userId: "u1", userAgent: CHROME });
    expect(h.events).toEqual([{ userId: "u1", userAgent: CHROME, success: true, failure: null }]);
  });

  it("a wrong password on a real account writes a 'Wrong password' line, opens no session, and still says the same thing to the caller", async () => {
    h.valid = false;
    await expect(localAuthProvider.login("a@b.co", "bad", CHROME)).rejects.toThrow("Invalid email or password");
    expect(h.events).toEqual([{ userId: "u1", userAgent: CHROME, success: false, failure: "Wrong password" }]);
    expect(h.sessions).toHaveLength(0);
  });

  it("an email that is nobody's writes nothing, and says the same thing as a wrong password", async () => {
    h.user = null;
    await expect(localAuthProvider.login("nobody@x.co", "pw", CHROME)).rejects.toThrow("Invalid email or password");
    expect(h.events).toHaveLength(0);
  });

  it("an account with no password (a social sign-in) writes nothing for a password attempt", async () => {
    h.user = { ...USER, passwordHash: null };
    await expect(localAuthProvider.login("a@b.co", "pw", CHROME)).rejects.toThrow("Invalid email or password");
    expect(h.events).toHaveLength(0);
  });

  it("a history that cannot be written does not stop a good sign-in", async () => {
    h.eventsFail = true;
    await expect(localAuthProvider.login("a@b.co", "pw", CHROME)).resolves.toMatchObject({ user: { id: "u1" } });
    expect(h.sessions).toHaveLength(1);
  });

  it("a header that is not a string is stored as no browser", async () => {
    await localAuthProvider.login("a@b.co", "pw", undefined);
    expect(h.sessions[0].userAgent).toBeNull();
  });
});

describe("the other ways in (Google, LinkedIn, a reset link) also leave a line and a browser", () => {
  it("createLocalTokens opens a session with the browser and writes a successful line", async () => {
    await createLocalTokens("u1", CHROME);
    expect(h.sessions[0]).toMatchObject({ userId: "u1", userAgent: CHROME });
    expect(h.events).toEqual([{ userId: "u1", userAgent: CHROME, success: true, failure: null }]);
  });
});
