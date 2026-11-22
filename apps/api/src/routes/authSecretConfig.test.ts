// The three HTTP entry points that open or renew a session (POST /auth/login, /auth/register, /auth/refresh), loaded with the REAL routes and
// the REAL local provider and a fake database, in a process that has no usable JWT_ACCESS_SECRET. index.ts refuses to start like that
// (lib/auth/config.ts); this is the defense in depth: if a process got here anyway, no route may hand out a session or a cookie, and nothing
// may be written on the way. (The login and register routes' own catch-all turns any error into a 4xx that carries its message; what is
// pinned here is that no session, cookie or row comes out of it, not that wording.)
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../lib/auth/sessionService.js";

const h = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  refreshRow: null as null | Record<string, unknown>,
  writes: [] as string[],
}));

vi.mock("../lib/prisma.js", () => {
  const write = (what: string, value: unknown = {}) => async () => {
    h.writes.push(what);
    return value;
  };
  return {
    prisma: {
      user: {
        findUnique: async () => h.user,
        create: async (a: { data: Record<string, unknown> }) => {
          h.writes.push("user.create");
          return { id: "u-new", avatarUrl: null, timezone: "UTC", ...a.data };
        },
        update: write("user.update"),
      },
      workspace: { create: write("workspace.create", { id: "w-new" }) },
      authSession: {
        create: async (a: { data: Record<string, unknown> }) => {
          h.writes.push("session.create");
          return { id: "s-new", ...a.data };
        },
        findFirst: async () => h.refreshRow,
        findUnique: async () => null,
        updateMany: write("session.update", { count: 1 }),
        deleteMany: write("session.delete", { count: 1 }),
      },
      loginEvent: { create: write("loginEvent.create") },
      emailVerification: { deleteMany: async () => ({ count: 0 }), create: write("emailVerification.create") },
    },
  };
});
vi.mock("../lib/mailer.js", () => ({ sendPasswordResetEmail: async () => {}, sendVerificationEmail: async () => {} }));
vi.mock("bcryptjs", () => ({ default: { compare: async () => true, hash: async () => "hash" } }));

const GOOD_SECRET = "0123456789abcdef".repeat(4);
const open: FastifyInstance[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
beforeEach(() => {
  h.user = null;
  h.refreshRow = null;
  h.writes = [];
});

// lib/auth/index.ts chooses the provider and localAuth.ts reads the secret when they are loaded, so each environment needs fresh modules
async function appWith(secret: string | undefined): Promise<FastifyInstance> {
  const saved = { secret: process.env.JWT_ACCESS_SECRET, provider: process.env.AUTH_PROVIDER };
  delete process.env.AUTH_PROVIDER;
  if (secret === undefined) delete process.env.JWT_ACCESS_SECRET;
  else process.env.JWT_ACCESS_SECRET = secret;
  vi.resetModules();
  try {
    const { userRoutes } = await import("./user.js");
    const app = Fastify();
    open.push(app);
    await app.register(cookie);
    await app.register(userRoutes);
    await app.ready();
    return app;
  } finally {
    if (saved.secret === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = saved.secret;
    if (saved.provider === undefined) delete process.env.AUTH_PROVIDER;
    else process.env.AUTH_PROVIDER = saved.provider;
  }
}

const aPerson = () => ({ id: "u1", email: "a@b.co", name: "A", avatarUrl: null, timezone: "UTC", passwordHash: "x" });
const aRefreshRow = (raw: string) => {
  const now = new Date();
  return { id: "s1", userId: "u1", tokenHash: hashToken(raw), prevTokenHash: null, rotatedAt: null, lastActiveAt: now, expiresAt: new Date(now.getTime() + 3_600_000), createdAt: now };
};
const login = (app: FastifyInstance) => app.inject({ method: "POST", url: "/auth/login", payload: { email: "a@b.co", password: "pw" } });
const register = (app: FastifyInstance) => app.inject({ method: "POST", url: "/auth/register", payload: { email: "new@b.co", password: "NewPassword123", name: "New" } });
const refresh = (app: FastifyInstance) => app.inject({ method: "POST", url: "/auth/refresh", cookies: { "ss-refresh-token": "refresh-1" } });

describe.each([
  ["unset", undefined],
  ["empty", ""],
])("with the signing secret %s, no route hands out a session", (_name, secret) => {
  it("POST /auth/login with the right password: refused, no cookie, nothing written", async () => {
    h.user = aPerson();
    const r = await login(await appWith(secret));
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.cookies).toEqual([]);
    expect(r.json()).not.toHaveProperty("user");
    expect(h.writes).toEqual([]);
  }, 30_000);

  it("POST /auth/register: refused, no cookie, no account, workspace or session created", async () => {
    const r = await register(await appWith(secret));
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.cookies).toEqual([]);
    expect(h.writes).toEqual([]);
  }, 30_000);

  it("POST /auth/refresh with a valid refresh cookie: a 500, no cookie, the session NOT rotated", async () => {
    h.refreshRow = aRefreshRow("refresh-1");
    const r = await refresh(await appWith(secret));
    expect(r.statusCode).toBe(500);
    expect(r.cookies).toEqual([]);
    expect(h.writes).toEqual([]); // before the check this rotated the session, threw, and left the browser holding a refresh token that was already dead
  }, 30_000);
});

describe("with a valid secret the same three routes work (so the tests above fail for the right reason)", () => {
  it("login: 200 with both cookies", async () => {
    h.user = aPerson();
    const r = await login(await appWith(GOOD_SECRET));
    expect(r.statusCode).toBe(200);
    expect(r.cookies.map((c) => c.name)).toEqual(expect.arrayContaining(["ss-access-token", "ss-refresh-token"]));
    expect(h.writes).toEqual(["session.create", "loginEvent.create"]);
  }, 30_000);

  it("register: 201 with both cookies", async () => {
    const r = await register(await appWith(GOOD_SECRET));
    expect(r.statusCode).toBe(201);
    expect(r.cookies.map((c) => c.name)).toEqual(expect.arrayContaining(["ss-access-token", "ss-refresh-token"]));
    expect(h.writes).toContain("user.create");
    expect(h.writes).toContain("session.create");
  }, 30_000);

  it("refresh: 200 with both cookies, and the session rotated once", async () => {
    h.refreshRow = aRefreshRow("refresh-1");
    const r = await refresh(await appWith(GOOD_SECRET));
    expect(r.statusCode).toBe(200);
    expect(r.cookies.map((c) => c.name)).toEqual(expect.arrayContaining(["ss-access-token", "ss-refresh-token"]));
    expect(h.writes).toEqual(["session.update"]);
  }, 30_000);
});
