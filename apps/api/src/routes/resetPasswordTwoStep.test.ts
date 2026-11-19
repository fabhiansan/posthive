// POST /auth/reset-password signs the person in after the new password is set. A reset link proves only that the person can
// read the mailbox, which two-step verification does not trust: when it is on, the reset sets the password and opens NO session,
// so the code is still asked for at the next login. (Before this was tested, a reset link was a way around the second step.)
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  totpEnabledAt: null as Date | null,
  reset: null as null | { id: string; userId: string; usedAt: Date | null; expiresAt: Date },
  revoked: [] as string[],
  tokensFor: [] as string[],
  claimed: [] as string[],
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    passwordReset: { findUnique: async () => h.reset },
    user: { findUnique: async (a: any) => (a.where.id === "u1" ? { totpEnabledAt: h.totpEnabledAt } : null) },
  },
}));
vi.mock("../lib/auth/passwordReset.js", () => ({
  claimResetAndSetPassword: async (id: string) => {
    h.claimed.push(id);
    return true;
  },
}));
vi.mock("../lib/auth/index.js", () => ({
  authProvider: { revokeOtherSessions: async (userId: string) => void h.revoked.push(userId) },
}));
vi.mock("../lib/auth/localAuth.js", () => ({
  createLocalTokens: async (userId: string) => {
    h.tokensFor.push(userId);
    return { accessToken: "access", refreshToken: "refresh" };
  },
}));
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async () => {},
  getUser: () => ({ id: "u1" }),
  getWorkspaceId: () => "ws",
  setAuthCookies: (reply: any) => reply.header("x-test-session", "open"),
  clearAuthCookies: () => {},
  isPersistent: () => true,
  ACCESS_COOKIE_NAME: "a",
  REFRESH_COOKIE_NAME: "r",
}));
vi.mock("../lib/mailer.js", () => ({ sendPasswordResetEmail: async () => {}, sendVerificationEmail: async () => {} }));
vi.mock("bcryptjs", () => ({ default: { hash: async () => "hash", compare: async () => true } }));

import { userRoutes } from "./user.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(cookie);
  await app.register(userRoutes);
  await app.ready();
});
afterAll(() => app.close());
beforeEach(() => {
  h.totpEnabledAt = null;
  h.reset = { id: "r1", userId: "u1", usedAt: null, expiresAt: new Date(Date.now() + 600_000) };
  h.revoked = [];
  h.tokensFor = [];
  h.claimed = [];
  delete process.env.AUTH_PROVIDER;
});

const reset = () => app.inject({ method: "POST", url: "/auth/reset-password", payload: { token: "t".repeat(64), password: "NewPassword123" } });

describe("POST /auth/reset-password", () => {
  it("an account without two-step is signed in after the reset, as before", async () => {
    const res = await reset();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, loggedIn: true });
    expect(res.headers["x-test-session"]).toBe("open");
    expect(h.tokensFor).toEqual(["u1"]);
  });

  it("an account WITH two-step has its password set and its other sessions ended, but no session is opened", async () => {
    h.totpEnabledAt = new Date("2026-11-18T03:00:00Z");
    const res = await reset();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, loggedIn: false }); // the web then sends the person to /login, where the code is asked
    expect(res.headers["x-test-session"]).toBeUndefined();
    expect(h.tokensFor).toEqual([]); // nothing was minted
    expect(h.claimed).toEqual(["r1"]); // the password WAS changed: the link is spent
    expect(h.revoked).toEqual(["u1"]); // and everything signed in with the old password is out
  });

  it("a link that is used up or has expired changes nothing and opens nothing, two-step or not", async () => {
    for (const totp of [null, new Date()]) {
      h.totpEnabledAt = totp;
      h.reset = { id: "r1", userId: "u1", usedAt: new Date(), expiresAt: new Date(Date.now() + 600_000) };
      expect((await reset()).statusCode).toBe(400);
      h.reset = { id: "r1", userId: "u1", usedAt: null, expiresAt: new Date(Date.now() - 1000) };
      expect((await reset()).statusCode).toBe(400);
    }
    expect(h.tokensFor).toEqual([]);
    expect(h.claimed).toEqual([]);
  });
});
