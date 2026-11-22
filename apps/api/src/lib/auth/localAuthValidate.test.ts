// What localAuthProvider.validateAccessToken answers, and what it lets through. The point of this file: a token the JWT library
// REJECTS is "no user" (null), and a database or unexpected failure is NOT: it propagates, so a caller (the guard, the Canvas
// auth gate) can tell "this credential is refused" from "authentication could not run". The database is faked; the JWT library,
// the session service, the guard and the gate are the real ones. It also covers a missing signing secret: nothing may be written.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => ({
  // localAuth reads the secret when it is loaded, which is before any line of this file runs
  secret: (process.env.JWT_ACCESS_SECRET = "test-access-secret"),
  session: null as null | { id: string; userId: string; tokenHash: string; prevTokenHash: null; rotatedAt: null; lastActiveAt: Date; expiresAt: Date; createdAt: Date },
  user: null as null | { id: string; email: string; name: string; avatarUrl: null; timezone: string },
  down: {} as Record<"session" | "user" | "touch" | "delete", boolean>,
  calls: { session: 0, user: 0, touch: 0, delete: 0, refreshLookup: 0 },
  refreshRow: null as null | { id: string; userId: string; tokenHash: string; prevTokenHash: null; rotatedAt: null; lastActiveAt: Date; expiresAt: Date; createdAt: Date },
  password: true,
  writes: [] as string[], // every write the fake database took, in order: an account, a workspace, a session, a sign-in line, a rotation
}));

const outage = () => Object.assign(new Error("Can't reach database server at `localhost:5433`"), { name: "PrismaClientInitializationError" });

vi.mock("../prisma.js", () => ({
  prisma: {
    authSession: {
      create: vi.fn(async (a: { data: Record<string, unknown> }) => {
        h.writes.push("session.create");
        return { id: "s-new", ...a.data };
      }),
      findFirst: vi.fn(async () => {
        h.calls.refreshLookup++;
        return h.refreshRow;
      }),
      findUnique: vi.fn(async () => {
        h.calls.session++;
        if (h.down.session) throw outage();
        return h.session;
      }),
      updateMany: vi.fn(async () => {
        h.calls.touch++;
        h.writes.push("session.update");
        if (h.down.touch) throw outage();
        return { count: 1 };
      }),
      deleteMany: vi.fn(async () => {
        h.calls.delete++;
        if (h.down.delete) throw outage();
        return { count: 1 };
      }),
    },
    user: {
      findUnique: vi.fn(async () => {
        h.calls.user++;
        if (h.down.user) throw outage();
        return h.user;
      }),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => {
        h.writes.push("user.create");
        return { id: "u-new", avatarUrl: null, timezone: "UTC", ...a.data };
      }),
      update: vi.fn(async () => {
        h.writes.push("user.update");
        return {};
      }),
    },
    workspace: {
      create: vi.fn(async () => {
        h.writes.push("workspace.create");
        return { id: "w-new" };
      }),
    },
    loginEvent: {
      create: vi.fn(async () => {
        h.writes.push("loginEvent.create");
        return {};
      }),
    },
  },
}));
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn(async () => h.password), hash: vi.fn(async () => "hash") } }));
// the gate module imports the real withAuth (which loads the real provider and prisma); this file builds its own guard
vi.mock("./withAuth.js", () => ({ withAuth: async () => {} }));

import { localAuthProvider } from "./localAuth.js";
import { createAuthGuard, SESSION_EXPIRED_BODY } from "./authGuard.js";
import { hashToken } from "./sessionService.js";
import { createCanvasAuthGate, makeCanvasWithAuth, registerCanvasAuthGate } from "../canvasAuthGate.js";

const SECRET = h.secret;
const sign = (claims: Record<string, unknown> = {}, opts: jwt.SignOptions = {}, secret: string = SECRET) =>
  jwt.sign({ sub: "u1", sid: "s1", type: "access", ...claims }, secret, { expiresIn: 900, ...opts });
const goodToken = () => sign();
const poisoned = (payload: Buffer) => Buffer.from(JSON.stringify({ typ: "JWT", alg: "HS256" })).toString("base64url") + "." + payload.toString("base64url") + ".c2ln";
const none = () => "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0." + Buffer.from(JSON.stringify({ sub: "u1", sid: "s1", type: "access" })).toString("base64url") + ".";

beforeEach(() => {
  const now = new Date();
  h.session = { id: "s1", userId: "u1", tokenHash: "x", prevTokenHash: null, rotatedAt: null, lastActiveAt: now, expiresAt: new Date(now.getTime() + 3_600_000), createdAt: now };
  h.user = { id: "u1", email: "a@b.co", name: "A", avatarUrl: null, timezone: "UTC" };
  h.down = { session: false, user: false, touch: false, delete: false };
  h.calls = { session: 0, user: 0, touch: 0, delete: 0, refreshLookup: 0 };
  h.refreshRow = null;
  h.password = true;
  h.writes = [];
});
afterEach(() => vi.restoreAllMocks());

describe("localAuthProvider.validateAccessToken: a REJECTED token is no user", () => {
  it("a valid token with a live session returns the person and the session id", async () => {
    expect(await localAuthProvider.validateAccessToken(goodToken())).toMatchObject({ id: "u1", email: "a@b.co", sessionId: "s1" });
  });

  const rejected: [string, () => unknown][] = [
    ["malformed", () => "garbage"],
    ["empty", () => ""],
    ["not three parts", () => "a.b"],
    ["a wrong signature", () => sign({}, {}, "some-other-secret")],
    ["algorithm none", none],
    ["expired", () => sign({}, { expiresIn: -10 })],
    ["not valid yet (nbf in the future)", () => sign({}, { notBefore: 3600 })],
    // jws JSON.parses the payload of a "typ: JWT" token BEFORE any signature check, so these escape jwt.verify as a raw SyntaxError (not a
    // JsonWebTokenError). They need no secret, so anyone can send one: they must be "no user", never a 500.
    ["typ JWT with a payload that is not JSON", () => poisoned(Buffer.from("notjson"))],
    ["typ JWT with a payload that is not UTF-8", () => poisoned(Buffer.from([0xff, 0xfe, 0xfd]))],
    ["typ JWT with a truncated JSON payload", () => poisoned(Buffer.from('{"sub":"u1",'))],
  ];
  it.each(rejected)("%s: null, and the database is never asked", async (_name, make) => {
    expect(await localAuthProvider.validateAccessToken(make() as string)).toBeNull();
    expect(h.calls).toEqual({ session: 0, user: 0, touch: 0, delete: 0, refreshLookup: 0 });
  });

  it("a signed token of the wrong type, or without a session id (it predates server-side sessions), is null without touching the database", async () => {
    expect(await localAuthProvider.validateAccessToken(sign({ type: "refresh" }))).toBeNull();
    expect(await localAuthProvider.validateAccessToken(jwt.sign({ sub: "u1", type: "access" }, SECRET, { expiresIn: 900 }))).toBeNull();
    expect(h.calls.session).toBe(0);
  });

  it("a session that is gone, someone else's, or the person's row that is gone: null (the credential is refused, nothing failed)", async () => {
    h.session = null;
    expect(await localAuthProvider.validateAccessToken(goodToken())).toBeNull();
    h.session = { ...(h.session as never), id: "s1", userId: "someone-else", lastActiveAt: new Date(), expiresAt: new Date(Date.now() + 1e6), createdAt: new Date(), tokenHash: "x", prevTokenHash: null, rotatedAt: null };
    expect(await localAuthProvider.validateAccessToken(goodToken())).toBeNull();
    h.session = { id: "s1", userId: "u1", tokenHash: "x", prevTokenHash: null, rotatedAt: null, lastActiveAt: new Date(), expiresAt: new Date(Date.now() + 1e6), createdAt: new Date() };
    h.user = null;
    expect(await localAuthProvider.validateAccessToken(goodToken())).toBeNull();
  });

  it("an idle-expired session is removed and the answer is null", async () => {
    h.session = { ...h.session!, lastActiveAt: new Date(Date.now() - 2 * 3_600_000) };
    expect(await localAuthProvider.validateAccessToken(goodToken())).toBeNull();
    expect(h.calls.delete).toBe(1);
  });
});

describe("localAuthProvider.validateAccessToken: a database or unexpected failure PROPAGATES, it is never 'no user'", () => {
  it.each([
    ["reading the session", "session"],
    ["reading the person", "user"],
    ["touching the session's last-active time (the write that follows a stale read)", "touch"],
    ["removing an expired session", "delete"],
  ] as const)("the database fails while %s: the call rejects with that error (not null)", async (_what, which) => {
    if (which === "touch") h.session = { ...h.session!, lastActiveAt: new Date(Date.now() - 10 * 60_000) }; // older than the touch throttle
    if (which === "delete") h.session = { ...h.session!, lastActiveAt: new Date(Date.now() - 2 * 3_600_000) };
    h.down[which] = true;
    await expect(localAuthProvider.validateAccessToken(goodToken())).rejects.toThrow(/Can't reach database/);
  });

  it("the same token is null while the database is up and a rejection while it is down: the two are told apart", async () => {
    h.session = null; // revoked
    expect(await localAuthProvider.validateAccessToken(goodToken())).toBeNull();
    h.down.session = true; // outage
    await expect(localAuthProvider.validateAccessToken(goodToken())).rejects.toThrow();
  });
});

describe("a missing JWT_ACCESS_SECRET is a configuration error, never 'no user' and never a failed credential", () => {
  // localAuth reads the secret when it is loaded, so a provider with no secret is a freshly loaded module. Unset, or empty: deploy/prod/env.example
  // ships `JWT_ACCESS_SECRET=`, which a forgetful operator leaves as it is.
  async function freshLocalAuth(value?: string) {
    const saved = process.env.JWT_ACCESS_SECRET;
    if (value === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = value;
    vi.resetModules();
    try {
      return await import("./localAuth.js");
    } finally {
      process.env.JWT_ACCESS_SECRET = saved;
    }
  }
  const withoutSecret = async (value?: string) => (await freshLocalAuth(value)).localAuthProvider;
  const open: FastifyInstance[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
  });

  it.each([
    ["an unset secret, a token that would have been valid", undefined, () => goodToken()],
    ["an unset secret, garbage", undefined, () => "garbage"],
    ["an unset secret, a token that is not JSON inside", undefined, () => poisoned(Buffer.from("notjson"))],
    ["an EMPTY secret, a token that would have been valid", "", () => goodToken()],
    ["an EMPTY secret, garbage", "", () => "garbage"],
  ])("validateAccessToken rejects with a configuration error for %s (it is not null, and the database is never asked)", async (_what, secret, token) => {
    const provider = await withoutSecret(secret);
    await expect(provider.validateAccessToken(token())).rejects.toThrow(/JWT_ACCESS_SECRET is not set/);
    expect(h.calls.session).toBe(0);
    expect(h.calls.user).toBe(0);
  });

  it("through the real guard and the Canvas auth gate: every request is a 500 with NO cookie cleared and nothing counted, however many (never a 401, never a 429)", async () => {
    const provider = await withoutSecret();
    const app = Fastify();
    open.push(app);
    await app.register(cookie);
    const gate = createCanvasAuthGate();
    const guard = createAuthGuard({ provider, resolveWorkspace: async (req) => { req.workspaceId = "w1"; } });
    await app.register(async (scope) => {
      registerCanvasAuthGate(scope, gate);
      scope.get("/p", { preHandler: [makeCanvasWithAuth(guard.withAuth)] }, async () => ({ ok: true }));
    });
    await app.ready();
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: "GET", url: "/p", remoteAddress: "10.0.0.1", cookies: { "ss-access-token": "some-token-" + i } });
      expect(r.statusCode).toBe(500);
      expect(r.cookies.filter((c) => c.value === "")).toEqual([]);
    }
    expect(gate.stats().failures).toEqual({});
    expect(gate.stats().newFailingHandles).toEqual({});
  });

  // Every way localAuth.ts opens or renews a session. (The routes that call createLocalTokens after writing something of their own, a reset link, the
  // second step of a two-step login, the OAuth callbacks, are protected by the startup check, not by anything here; the two-step login test below
  // covers only the first step: no challenge is written by such a process.) With no secret the access token cannot be signed, so anything written BEFORE that point is a
  // half-finished sign-in: an account whose retry says "Email already in use", a session and a "signed in" line nobody got a token for, a
  // refresh token already rotated (the old one dies, the new one never reaches the browser, and the 30 s grace later reads as reuse).
  const GOOD_SECRET = "0123456789abcdef".repeat(4);
  const NO_SECRET: [string, string | undefined][] = [["unset", undefined], ["empty", ""]];
  const freshRefreshRow = (raw: string) => {
    const now = new Date();
    return { id: "s1", userId: "u1", tokenHash: hashToken(raw), prevTokenHash: null, rotatedAt: null, lastActiveAt: now, expiresAt: new Date(now.getTime() + 3_600_000), createdAt: now };
  };
  const knownPerson = () => {
    h.user = { ...h.user!, passwordHash: "x" } as never; // login needs an account that has a password
  };

  describe.each(NO_SECRET)("with the secret %s, no sign-in or refresh path opens a session or writes anything but a failed-attempt line", (_name, secret) => {
    it("login with the RIGHT password", async () => {
      knownPerson();
      const { localAuthProvider: provider } = await freshLocalAuth(secret);
      await expect(provider.login("a@b.co", "pw", "ua")).rejects.toThrow(/JWT_ACCESS_SECRET is not set/);
      expect(h.writes).toEqual([]); // no session, no sign-in line
    });

    it("login with the right password to an account that has TWO-STEP on: refused before any challenge could be written, nothing spent", async () => {
      h.user = { ...h.user!, passwordHash: "x", totpEnabledAt: new Date() } as never;
      const { localAuthProvider: provider } = await freshLocalAuth(secret);
      await expect(provider.login("a@b.co", "pw", "ua")).rejects.toThrow(/JWT_ACCESS_SECRET is not set/); // before the check this answered "twoStepRequired" and the route wrote a challenge
      expect(h.writes).toEqual([]);
    });

    it("login with a WRONG password: the ordinary refusal, the configuration error is not shown to someone guessing, and the failed attempt is still recorded", async () => {
      knownPerson();
      h.password = false;
      const { localAuthProvider: provider } = await freshLocalAuth(secret);
      await expect(provider.login("a@b.co", "bad", "ua")).rejects.toThrow("Invalid email or password");
      expect(h.writes).toEqual(["loginEvent.create"]);
    });

    it("register: before the account exists, so the person can simply try again once the server is fixed", async () => {
      h.user = null; // nobody has this email yet
      const { localAuthProvider: provider } = await freshLocalAuth(secret);
      await expect(provider.register("new@b.co", "Passw0rd!x", "New", "ua")).rejects.toThrow(/JWT_ACCESS_SECRET is not set/);
      expect(h.writes).toEqual([]); // no user, no workspace, no session
      expect(h.calls.user).toBe(0); // not even the lookup: the first thing register does is the check
    });

    it("createLocalTokens itself (what Google and LinkedIn sign-in, a password-reset link and the second step of a two-step login call)", async () => {
      const { createLocalTokens } = await freshLocalAuth(secret);
      await expect(createLocalTokens("u1", "ua")).rejects.toThrow(/JWT_ACCESS_SECRET is not set/);
      expect(h.writes).toEqual([]);
    });

    it("refreshTokens with a refresh token that is valid: nothing is looked up and nothing is rotated", async () => {
      h.refreshRow = freshRefreshRow("refresh-1");
      const { localAuthProvider: provider } = await freshLocalAuth(secret);
      await expect(provider.refreshTokens("refresh-1")).rejects.toThrow(/JWT_ACCESS_SECRET is not set/);
      expect(h.calls.refreshLookup).toBe(0);
      expect(h.writes).toEqual([]);
    });

    it("a refresh-only request through the real guard: a 500 with no cookie set or cleared, the old refresh token still valid", async () => {
      h.refreshRow = freshRefreshRow("refresh-1");
      const provider = await withoutSecret(secret);
      const app = Fastify();
      open.push(app);
      await app.register(cookie);
      const guard = createAuthGuard({ provider, resolveWorkspace: async (req) => { req.workspaceId = "w1"; } });
      app.get("/p", { preHandler: [guard.withAuth] }, async () => ({ ok: true }));
      await app.ready();
      const r = await app.inject({ method: "GET", url: "/p", cookies: { "ss-refresh-token": "refresh-1" } });
      expect(r.statusCode).toBe(500);
      expect(r.cookies).toEqual([]); // not the new tokens, and not the three cleared cookies of a "session expired" answer
      expect(h.calls.refreshLookup).toBe(0);
      expect(h.writes).toEqual([]); // before the check this rotated the session and THEN threw
    });
  });

  describe("the same calls with a valid secret still do their work (so the tests above fail for the right reason)", () => {
    it("login writes a session and a sign-in line, in that order", async () => {
      knownPerson();
      const { localAuthProvider: provider } = await freshLocalAuth(GOOD_SECRET);
      expect(await provider.login("a@b.co", "pw", "ua")).toHaveProperty("accessToken");
      expect(h.writes).toEqual(["session.create", "loginEvent.create"]);
    });

    it("login to a two-step account answers 'a code is needed' and writes nothing (the route writes the challenge)", async () => {
      h.user = { ...h.user!, passwordHash: "x", totpEnabledAt: new Date() } as never;
      const { localAuthProvider: provider } = await freshLocalAuth(GOOD_SECRET);
      expect(await provider.login("a@b.co", "pw", "ua")).toEqual({ twoStepRequired: true, userId: "u1" });
      expect(h.writes).toEqual([]);
    });

    it("register writes the account, the workspace, the active-workspace link, a session and a sign-in line", async () => {
      h.user = null;
      const { localAuthProvider: provider } = await freshLocalAuth(GOOD_SECRET);
      expect(await provider.register("new@b.co", "Passw0rd!x", "New", "ua")).toHaveProperty("accessToken");
      expect(h.writes).toEqual(["user.create", "workspace.create", "user.update", "session.create", "loginEvent.create"]);
    });

    it("createLocalTokens writes a session and a sign-in line", async () => {
      const { createLocalTokens } = await freshLocalAuth(GOOD_SECRET);
      expect(await createLocalTokens("u1", "ua")).toHaveProperty("accessToken");
      expect(h.writes).toEqual(["session.create", "loginEvent.create"]);
    });

    it("refreshTokens rotates the session and hands back both tokens", async () => {
      h.refreshRow = freshRefreshRow("refresh-1");
      const { localAuthProvider: provider } = await freshLocalAuth(GOOD_SECRET);
      expect(await provider.refreshTokens("refresh-1")).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
      expect(h.writes).toEqual(["session.update"]);
    });

    it("a refresh-only request through the real guard is a 200 that sets both cookies", async () => {
      h.refreshRow = freshRefreshRow("refresh-1");
      const provider = await withoutSecret(GOOD_SECRET);
      const app = Fastify();
      open.push(app);
      await app.register(cookie);
      const guard = createAuthGuard({ provider, resolveWorkspace: async (req) => { req.workspaceId = "w1"; } });
      app.get("/p", { preHandler: [guard.withAuth] }, async () => ({ ok: true }));
      await app.ready();
      const r = await app.inject({ method: "GET", url: "/p", cookies: { "ss-refresh-token": "refresh-1" } });
      expect(r.statusCode).toBe(200);
      expect(r.cookies.map((c) => c.name).sort()).toEqual(["ss-access-token", "ss-refresh-token", "ss-session-only"]);
      expect(h.writes).toEqual(["session.update"]);
    });
  });
});

describe("app-wide: a route with no gate at all (the way /jobs uses the guard) and the SSE-style ?token= route", () => {
  const open: FastifyInstance[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
  });
  async function build() {
    const app = Fastify();
    open.push(app);
    await app.register(cookie);
    const guard = createAuthGuard({ provider: localAuthProvider, resolveWorkspace: async (req) => { req.workspaceId = "w1"; } });
    app.get("/plain", { preHandler: [guard.withAuth] }, async () => ({ ok: true })); // exactly how routes/jobs.ts declares its routes
    app.get("/sse", { preHandler: [guard.withAuthOrToken] }, async () => ({ ok: true }));
    await app.ready();
    return { app };
  }
  const cleared = (r: { cookies: { name: string; value: string }[] }) => r.cookies.filter((c) => c.value === "").map((c) => c.name).sort();

  it("a database outage on a non-Canvas authenticated route is a 500 and clears NO cookie (before: a 401 that signed the person out)", async () => {
    const { app } = await build();
    const cookies = { "ss-access-token": goodToken() };
    expect((await app.inject({ method: "GET", url: "/plain", cookies })).statusCode).toBe(200);

    h.down.session = true;
    const r = await app.inject({ method: "GET", url: "/plain", cookies });
    expect(r.statusCode).toBe(500);
    expect(cleared(r)).toEqual([]);
    expect(r.json()).not.toEqual(SESSION_EXPIRED_BODY);

    h.down.session = false; // and the person is still signed in once the database is back
    expect((await app.inject({ method: "GET", url: "/plain", cookies })).statusCode).toBe(200);
  });

  it("the same route still answers a genuinely revoked session with a 401 and cleared cookies, and a garbage or poisoned token with a 401 (never a 500)", async () => {
    const { app } = await build();
    h.session = null;
    const revoked = await app.inject({ method: "GET", url: "/plain", cookies: { "ss-access-token": goodToken() } });
    expect(revoked.statusCode).toBe(401);
    expect(cleared(revoked)).toEqual(["ss-access-token", "ss-refresh-token", "ss-session-only"]);
    for (const bad of ["garbage", poisoned(Buffer.from("notjson"))]) {
      const r = await app.inject({ method: "GET", url: "/plain", cookies: { "ss-access-token": bad } });
      expect(r.statusCode).toBe(401);
    }
  });

  it("an outage on the ?token= route is a 500 too, and a garbage ?token= is a 401", async () => {
    const { app } = await build();
    h.down.user = true;
    expect((await app.inject({ method: "GET", url: "/sse?token=" + goodToken() })).statusCode).toBe(500);
    h.down.user = false;
    expect((await app.inject({ method: "GET", url: "/sse?token=" + goodToken() })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/sse?token=garbage" })).statusCode).toBe(401);
  });
});

describe("through the real guard and the Canvas auth gate: a database outage is an ERROR, a refused credential is a FAILURE", () => {
  const open: FastifyInstance[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
  });
  async function build() {
    const app = Fastify();
    open.push(app);
    await app.register(cookie);
    const gate = createCanvasAuthGate();
    const guard = createAuthGuard({ provider: localAuthProvider, resolveWorkspace: async (req) => { req.workspaceId = "w1"; } });
    await app.register(async (scope) => {
      registerCanvasAuthGate(scope, gate);
      scope.get("/p", { preHandler: [makeCanvasWithAuth(guard.withAuth)] }, async () => ({ ok: true }));
    });
    await app.ready();
    const hit = (cookies: Record<string, string>) => app.inject({ method: "GET", url: "/p", remoteAddress: "10.0.0.1", cookies });
    return { gate, hit };
  }
  const cleared = (r: { cookies: { name: string; value: string }[] }) => r.cookies.filter((c) => c.value === "").map((c) => c.name).sort();

  it("a database outage on an access-only request: 500, no cookie cleared, nothing counted, the known-good mark kept, never a 429, and the next request works", async () => {
    const { gate, hit } = await build();
    const token = goodToken();
    const mark = gate.handleOf("a", token);
    expect((await hit({ "ss-access-token": token })).statusCode).toBe(200);
    expect(gate.stats().good).toContain(mark);

    h.down.session = true; // the outage
    for (let i = 0; i < 6; i++) {
      const r = await hit({ "ss-access-token": token });
      expect(r.statusCode).toBe(500); // before this change: a 401 with the cookies cleared, counted as a failed credential
      expect(cleared(r)).toEqual([]);
    }
    expect(gate.stats().failures).toEqual({});
    expect(gate.stats().newFailingHandles).toEqual({});
    expect(gate.stats().good).toContain(mark);
    expect(gate.stats().flights).toBe(0);

    h.down.session = false; // the database is back: not locked out
    expect((await hit({ "ss-access-token": token })).statusCode).toBe(200);
  });

  it("an outage with both cookies present is the same: the access check throws, the request is a 500, nothing is counted", async () => {
    const { gate, hit } = await build();
    h.down.user = true;
    const r = await hit({ "ss-access-token": goodToken(), "ss-refresh-token": "some-refresh-token" });
    expect(r.statusCode).toBe(500);
    expect(cleared(r)).toEqual([]);
    expect(h.calls.refreshLookup).toBe(0); // the guard did not carry on to the refresh token after the access check threw
    expect(gate.stats().failures).toEqual({});
    expect(gate.stats().newFailingHandles).toEqual({});
  });

  it("a revoked session (the database answers, the session is gone) IS a failure: 401, cookies cleared, counted, the mark cleared", async () => {
    const { gate, hit } = await build();
    const token = goodToken();
    expect((await hit({ "ss-access-token": token })).statusCode).toBe(200);
    h.session = null;
    const r = await hit({ "ss-access-token": token });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual(SESSION_EXPIRED_BODY);
    expect(cleared(r)).toEqual(["ss-access-token", "ss-refresh-token", "ss-session-only"]);
    expect(gate.stats().failures[gate.handleOf("a", token)]).toBe(1);
    expect(gate.stats().good).not.toContain(gate.handleOf("a", token));
  });

  it("a token with a non-JSON payload is a refused credential too: 401 and counted, three times, then 429 (not a 500 that counts nothing)", async () => {
    const { gate, hit } = await build();
    const token = poisoned(Buffer.from("notjson"));
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await hit({ "ss-access-token": token })).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]);
    expect(gate.stats().failures[gate.handleOf("a", token)]).toBe(3);
    expect(h.calls.session).toBe(0);
    // and with a valid-looking refresh token next to it the guard still reaches the refresh step (it is not stuck on the poisoned access cookie)
    const both = await hit({ "ss-access-token": poisoned(Buffer.from("other")), "ss-refresh-token": "some-refresh-token" });
    expect(both.statusCode).toBe(401); // the refresh token is unknown to the faked database: refused, cookies cleared
    expect(h.calls.refreshLookup).toBe(1);
  });

  it("a garbage token IS a failure: 401 and counted, three times, then 429 (the database is never asked)", async () => {
    const { gate, hit } = await build();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await hit({ "ss-access-token": "garbage" })).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]);
    expect(gate.stats().failures[gate.handleOf("a", "garbage")]).toBe(3);
    expect(h.calls.session).toBe(0);
  });
});
