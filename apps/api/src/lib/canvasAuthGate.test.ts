import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import net from "node:net";
import { createAuthGuard, SESSION_EXPIRED_BODY, UNAUTHENTICATED_BODY } from "./auth/authGuard.js";
import type { AuthProvider } from "./auth/types.js";
import { guessLimit } from "./ipRateLimit.js";
import { userLimit } from "./userRateLimit.js";

// The gate module imports the real withAuth (it loads prisma); these tests build their own guard around a provider double.
vi.mock("./auth/withAuth.js", () => ({ withAuth: async () => {} }));
import { createCanvasAuthGate, makeCanvasWithAuth, registerCanvasAuthGate, type CanvasAuthGate, type GateParams } from "./canvasAuthGate.js";

/**
 * What the Canvas auth gate promises, proven against the REAL guard (createAuthGuard), the real cookie plugin, the real gate and the
 * real per-user limiter, with a provider double that counts every authentication call. "Calls" below means provider calls
 * (validateAccessToken + refreshTokens): the unit of authentication work (a database read locally, a remote call under Supabase).
 * Nothing here is a load test: every number is a call count in a deterministic harness.
 */

const A = "ss-access-token";
const R = "ss-refresh-token";
const USER = { email: "a@b.c", name: "A", avatarUrl: null, timezone: "UTC" };

interface Gate {
  promise: Promise<void>;
  open(): void;
}
const deferred = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function makeWorld(shape: "local" | "supabase" = "local") {
  const sessions = new Set(["s1", "s2"]);
  const calls = { validate: 0, refresh: 0, total: 0 };
  const inflight = new Map<string, number>();
  let maxConcurrent = 0;
  const w = {
    sessions,
    calls,
    /** Runs at the start of every provider call (n = 1-based index over ALL calls); the test holds calls here. */
    before: null as null | ((n: number) => Promise<void> | void),
    throwAt: null as null | ((n: number) => boolean),
    rf: { current: "rf-1", prev: null as string | null, n: 1 },
    maxConcurrent: () => maxConcurrent,
    provider: null as unknown as AuthProvider,
  };
  const enter = async (token: string) => {
    const n = ++calls.total;
    const c = (inflight.get(token) ?? 0) + 1;
    inflight.set(token, c);
    maxConcurrent = Math.max(maxConcurrent, c);
    try {
      await w.before?.(n);
      if (w.throwAt?.(n)) throw new Error("provider down");
    } finally {
      inflight.set(token, (inflight.get(token) ?? 1) - 1);
    }
  };
  w.provider = {
    register: async () => {
      throw new Error("unused");
    },
    login: async () => {
      throw new Error("unused");
    },
    logout: async () => {},
    validateAccessToken: async (token) => {
      calls.validate++;
      await enter(token);
      const m = /^good:(.+)$/.exec(token);
      if (!m || !sessions.has(m[1])) return null;
      return { ...USER, id: `user-${m[1]}`, ...(shape === "supabase" ? {} : { sessionId: m[1] }) };
    },
    refreshTokens: async (token) => {
      calls.refresh++;
      await enter(token);
      if (!sessions.has("s1")) return null;
      if (token === w.rf.current) {
        w.rf.prev = token;
        w.rf.n++;
        w.rf.current = `rf-${w.rf.n}`;
        return { accessToken: "good:s1", refreshToken: w.rf.current };
      }
      if (token === w.rf.prev) return { accessToken: "good:s1", refreshToken: null }; // the grace window: no new refresh cookie
      return null;
    },
  };
  return w;
}
type World = ReturnType<typeof makeWorld>;

const open: FastifyInstance[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (open.length) await open.pop()!.close();
});

interface Built {
  app: FastifyInstance;
  gate: CanvasAuthGate;
  world: World;
  hit(cookies?: Record<string, string>, ip?: string, url?: string, headers?: Record<string, string>): ReturnType<FastifyInstance["inject"]>;
  slow: Gate;
}

async function build(opts: { params?: Partial<GateParams>; world?: World; now?: () => number; rate?: number; log?: { error(o: unknown, m?: string): void }; logger?: object } = {}): Promise<Built> {
  const world = opts.world ?? makeWorld();
  const app = Fastify(opts.logger ? { logger: opts.logger } : {});
  await app.register(cookie);
  if (opts.rate !== undefined) await app.register(rateLimit, { global: true, max: 1000, timeWindow: "1 minute", keyGenerator: (req) => req.ip });
  // waitMs is long by default: a test that parks requests behind a held leader must not be at the mercy of a slow machine. The stall tests set 2 s.
  const gate = createCanvasAuthGate({ params: { waitMs: 60_000, ...opts.params }, now: opts.now, log: opts.log });
  const guard = createAuthGuard({ provider: world.provider, resolveWorkspace: async (req) => { req.workspaceId = "w1"; } });
  const withGatedAuth = makeCanvasWithAuth(guard.withAuth);
  const slow = deferred();
  await app.register(async (scope) => {
    registerCanvasAuthGate(scope, gate);
    const route = opts.rate !== undefined ? { config: userLimit(opts.rate) } : {};
    scope.get("/p", { preHandler: [withGatedAuth], ...route }, async (req) => ({ ok: true, via: req.authVia }));
    scope.post("/body", { preHandler: [withGatedAuth] }, async () => ({ ok: true }));
    scope.get("/slow", { preHandler: [withGatedAuth] }, async () => {
      await slow.promise;
      return { ok: true };
    });
    // a route that refuses BEFORE authentication runs (like needsLocalStorage on the asset routes)
    scope.get("/early", { preHandler: [async (_req, reply) => reply.status(415).send({ error: "no" }), withGatedAuth] }, async () => ({ ok: true }));
  });
  await app.ready();
  open.push(app);
  const hit: Built["hit"] = (cookies, ip = "10.0.0.1", url = "/p", headers) =>
    app.inject({ method: "GET", url, remoteAddress: ip, ...(cookies ? { cookies } : {}), ...(headers ? { headers } : {}) });
  return { app, gate, world, hit, slow };
}

const tally = (rs: { statusCode: number }[]) => rs.reduce<Record<number, number>>((m, r) => ((m[r.statusCode] = (m[r.statusCode] ?? 0) + 1), m), {});
const acc = (v: string) => ({ [A]: v });
const pair = (a: string, r: string) => ({ [A]: a, [R]: r });
const cleared = (r: { cookies: { name: string; value: string }[] }) => r.cookies.filter((c) => c.value === "").map((c) => c.name).sort();

describe("anonymous requests (no auth cookie) are counted per address and never reach the provider", () => {
  const variants: [string, (i: number) => { cookies?: Record<string, string>; headers?: Record<string, string>; url?: string }][] = [
    ["no cookies at all", () => ({})],
    ["ss-session-only", () => ({ cookies: { "ss-session-only": "1" } })],
    ["random cookie names and values, rotating", (i) => ({ cookies: { [`junk${i}`]: `v${i}` } })],
    ["an empty ss-access-token", () => ({ cookies: { [A]: "" } })],
    ["the legacy access_token name, rotating", (i) => ({ cookies: { access_token: `x${i}` } })],
    ["a rotating Authorization: Bearer", (i) => ({ headers: { authorization: `Bearer x${i}` } })],
    ["a rotating ?token=", (i) => ({ url: `/p?token=x${i}` })],
  ];
  it.each(variants)("%s cannot get past the per-address limit", async (_name, make) => {
    let t = 0;
    const { hit, world, gate } = await build({ params: { anon: 3 }, now: () => t });
    const send = (i: number, ip = "10.0.0.1") => {
      const v = make(i);
      return hit(v.cookies, ip, v.url, v.headers);
    };
    const first = await Promise.all([0, 1, 2].map((i) => send(i)));
    expect(first.map((r) => r.statusCode)).toEqual([401, 401, 401]);
    const refused = await send(3);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("60"); // the window, in seconds
    expect(world.calls.total).toBe(0); // zero authentication work, however many
    expect((await send(4, "10.0.0.2")).statusCode).toBe(401); // another address is not affected
    t += 61_000; // the window passes
    expect((await send(5)).statusCode).toBe(401);
    expect(gate.stats().failures).toEqual({}); // an anonymous request touches no credential counter
  });
});

describe("credential counting: T counts attempts, F counts handles", () => {
  it("a handle is blocked after 3 failed attempts and F moves once, when the handle is first seen failing", async () => {
    const { hit, world, gate } = await build();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await hit(acc("bad-1"))).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    expect(world.calls.total).toBe(3); // the 4th and 5th did no authentication
    const h = gate.handleOf("a", "bad-1");
    expect(gate.stats().failures[h]).toBe(3);
    expect(Object.values(gate.stats().newFailingHandles)).toEqual([1]); // F: one handle, once, not 3
  });

  it("one request with two new handles adds exactly 2; the same pair again adds 0", async () => {
    const { hit, gate } = await build();
    await hit(pair("bad-a", "bad-r"));
    expect(Object.values(gate.stats().newFailingHandles)).toEqual([2]);
    await hit(pair("bad-a", "bad-r"));
    expect(Object.values(gate.stats().newFailingHandles)).toEqual([2]);
    expect(gate.stats().failures[gate.handleOf("a", "bad-a")]).toBe(2);
    expect(gate.stats().failures[gate.handleOf("r", "bad-r")]).toBe(2);
  });

  it("a failure after the handle's window creates a new entry and moves F again", async () => {
    let t = 0;
    const { hit, gate } = await build({ now: () => t });
    await hit(acc("bad-1"));
    t += 61_000;
    await hit(acc("bad-1"));
    expect(Object.values(gate.stats().newFailingHandles)).toEqual([1]); // the old F entry expired too; one in the new window
    expect(gate.stats().failures[gate.handleOf("a", "bad-1")]).toBe(1);
  });

  it("requests the gate answers itself (429) never touch T or F", async () => {
    const { hit, gate } = await build({ params: { failures: 1 } });
    await hit(acc("bad-1"));
    const before = JSON.stringify(gate.stats());
    const blocked = await hit(acc("bad-1"));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(JSON.stringify(gate.stats())).toBe(before);
  });

  it("the work is bounded: fixed access + rotating refresh stops at 3; rotating both stops at F", async () => {
    const one = await build();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await one.hit(pair("expired", `bad-${i}`))).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429, 429]); // the access handle repeats
    expect(one.world.calls.total).toBe(6); // 3 attempts x (validate + refresh)

    const both = await build({ params: { newFailingHandles: 5 } });
    const codes2: number[] = [];
    for (let i = 0; i < 5; i++) codes2.push((await both.hit(pair(`bad-a${i}`, `bad-r${i}`))).statusCode);
    expect(codes2).toEqual([401, 401, 401, 429, 429]); // two new handles per request: 6 >= 5 after the third
    expect(both.world.calls.total).toBe(6);
  });
});

describe("an expired access token takes the same path whatever is wrong with it", () => {
  it("with a VALID refresh it is a success that no counter sees", async () => {
    const { hit, gate, world } = await build({ params: { anon: 1, newFailingHandles: 1, failures: 1 } });
    const r = await hit(pair("expired", "rf-1"));
    expect(r.statusCode).toBe(200);
    expect(r.cookies.filter((c) => c.value !== "").map((c) => c.name).sort()).toEqual([A, R]); // rotated (the session-only marker is cleared, not set)
    expect(gate.stats().failures).toEqual({});
    expect(gate.stats().newFailingHandles).toEqual({});
    expect(gate.stats().keys.includes("10.0.0.1")).toBe(false); // not the anonymous counter either
    expect(world.calls.refresh).toBe(1);
  });

  it("with NO refresh: the first 3 are the real 401 with the cookies cleared, then 429 with the provider frozen", async () => {
    const { hit, world } = await build();
    const rs = [await hit(acc("expired")), await hit(acc("expired")), await hit(acc("expired"))];
    for (const r of rs) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual(SESSION_EXPIRED_BODY);
      expect(cleared(r)).toEqual([A, R, "ss-session-only"]);
    }
    expect((await hit(acc("expired"))).statusCode).toBe(429);
    expect(world.calls.total).toBe(3);
  });

  it("with an INVALID refresh: 3 real 401s then 429; rotating the refresh with a fixed access stops at 3", async () => {
    const { hit, world } = await build();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await hit(pair("expired", `junk-${i}`))).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    expect(world.calls.total).toBe(6);
  });

  it.each(["expired", "bad.signature.jwt", "eyJhbGciOiJub25lIn0.e30.", "garbage", ""])("access %j with a valid refresh succeeds, with an invalid one fails: the gate never inspects the token", async (token) => {
    const ok = await build();
    const withValid = await ok.hit(token ? pair(token, "rf-1") : { [R]: "rf-1" });
    expect(withValid.statusCode).toBe(200);
    const bad = await build();
    const withInvalid = await bad.hit(token ? pair(token, "nope") : { [R]: "nope" });
    expect(withInvalid.statusCode).toBe(401);
  });

  it("the initial 401 is exactly what withAuth sends, for no cookie and for a bad one", async () => {
    const { hit } = await build();
    const none = await hit(undefined);
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual(UNAUTHENTICATED_BODY);
    const bad = await hit(pair("stale", "dead"));
    expect(bad.json()).toEqual(SESSION_EXPIRED_BODY);
    expect(cleared(bad)).toEqual([A, R, "ss-session-only"]);
  });
});

describe("single-flight: the exact numbers (waiter cap 100, cohort cap 100)", () => {
  it.each([
    [50, { 200: 50 }, 50],
    [150, { 200: 101, 429: 49 }, 101],
  ])("a valid session, %i parallel requests: statuses %j and %i provider calls (as many as without the gate)", async (n, statuses, calls) => {
    const { hit, world, gate } = await build();
    const hold = deferred();
    world.before = async (i) => { if (i === 1) await hold.promise; };
    const rs = Array.from({ length: n }, () => hit(acc("good:s1")));
    await until(() => gate.stats().parked === Math.min(n - 1, 100), "waiters parked");
    hold.open();
    expect(tally(await Promise.all(rs))).toEqual(statuses);
    expect(world.calls.total).toBe(calls);
    expect(world.calls.refresh).toBe(0);
    expect(gate.stats().flights).toBe(0); // the flight ended when the last member finished authenticating
    expect(gate.stats().parked).toBe(0);
  });

  it.each([
    [50, { 200: 50 }, 50],
    [150, { 200: 101, 429: 49 }, 101],
  ])("the rollover (expired access + valid refresh), %i parallel: statuses %j and %i refresh calls (one rotate, the rest grace)", async (n, statuses, refreshCalls) => {
    const { hit, world, gate } = await build();
    const hold = deferred();
    world.before = async (i) => { if (i === 1) await hold.promise; };
    const rs = Array.from({ length: n }, () => hit(pair("expired", "rf-1")));
    await until(() => gate.stats().parked === Math.min(n - 1, 100), "waiters parked");
    hold.open();
    expect(tally(await Promise.all(rs))).toEqual(statuses);
    expect(world.calls.refresh).toBe(refreshCalls);
    expect(gate.stats().flights).toBe(0);
  });

  it("the flight lasts as long as authentication, never as long as the handler: siblings are not held behind a slow handler", async () => {
    const { hit, world, gate, slow } = await build();
    const hold = deferred();
    world.before = async (i) => { if (i === 1) await hold.promise; };
    const leader = hit(acc("good:s1"), "10.0.0.1", "/slow");
    await until(() => world.calls.total === 1, "leader authenticating");
    const siblings = Array.from({ length: 4 }, () => hit(acc("good:s1")));
    await until(() => gate.stats().parked === 4, "siblings parked");
    hold.open();
    expect(tally(await Promise.all(siblings))).toEqual({ 200: 4 }); // answered while the leader's handler is still blocked
    slow.open();
    expect((await leader).statusCode).toBe(200);
  });

  it.each([
    [50, { 401: 50 }],
    [150, { 401: 101, 429: 49 }],
  ])("a FAILED leader (never-valid credentials), %i parallel: 2 provider calls, statuses %j, identical 401s; T stops it after 3 rounds (6 calls)", async (n, statuses) => {
    const { hit, world, gate } = await build();
    const hold = deferred();
    world.before = async (i) => { if (i === 1) await hold.promise; };
    const rs = Array.from({ length: n }, () => hit(pair("bad-a", "bad-r")));
    await until(() => gate.stats().parked === Math.min(n - 1, 100), "waiters parked");
    hold.open();
    const done = await Promise.all(rs);
    expect(tally(done)).toEqual(statuses);
    expect(world.calls.total).toBe(2); // the leader's validate and refresh: nothing else authenticated
    const answered = done.filter((r) => r.statusCode === 401);
    expect(new Set(answered.map((r) => r.body)).size).toBe(1); // a free copy is the same answer
    expect(new Set(answered.map((r) => JSON.stringify(r.headers["set-cookie"]))).size).toBe(1);
    expect(cleared(answered[0])).toEqual([A, R, "ss-session-only"]);
    expect(gate.stats().failures[gate.handleOf("a", "bad-a")]).toBe(1); // copies are not attempts
    // rounds 2 and 3 are real attempts; round 4 is refused with the provider frozen
    expect((await hit(pair("bad-a", "bad-r"))).statusCode).toBe(401);
    expect((await hit(pair("bad-a", "bad-r"))).statusCode).toBe(401);
    expect(world.calls.total).toBe(6);
    expect((await hit(pair("bad-a", "bad-r"))).statusCode).toBe(429);
    expect(world.calls.total).toBe(6);
  });
});

describe("a known-good credential whose session was revoked", () => {
  async function establishKnownGood(b: Built) {
    const first = await b.hit(pair("good:s1", "rf-1"));
    expect(first.statusCode).toBe(200);
    expect(b.gate.stats().good).toContain(b.gate.handleOf("a", "good:s1"));
    b.world.sessions.delete("s1");
  }

  it.each([
    [50, { 401: 50 }],
    [150, { 401: 101, 429: 49 }],
  ])("the leader FAILS, %i parallel: 2 calls, statuses %j, marks cleared, 6 calls after three rounds, then 429", async (n, statuses) => {
    const b = await build();
    await establishKnownGood(b);
    const base = b.world.calls.total;
    const hold = deferred();
    b.world.before = async (i) => { if (i === base + 1) await hold.promise; };
    const rs = Array.from({ length: n }, () => b.hit(pair("good:s1", "rf-1")));
    await until(() => b.gate.stats().parked === Math.min(n - 1, 100), "waiters parked");
    hold.open();
    expect(tally(await Promise.all(rs))).toEqual(statuses);
    expect(b.world.calls.total - base).toBe(2);
    expect(b.gate.stats().good).not.toContain(b.gate.handleOf("a", "good:s1"));
    await b.hit(pair("good:s1", "rf-1"));
    await b.hit(pair("good:s1", "rf-1"));
    expect(b.world.calls.total - base).toBe(6);
    expect((await b.hit(pair("good:s1", "rf-1"))).statusCode).toBe(429);
    expect(b.world.calls.total - base).toBe(6);
  });

  it("REGRESSION: revoked AFTER the leader succeeded and BEFORE the released waiters finish (50 parallel)", async () => {
    const b = await build({ params: { failures: 3 } });
    const leaderGate = deferred();
    const memberGate = deferred();
    b.world.before = async (n) => { await (n === 1 ? leaderGate : memberGate).promise; };
    const mine = acc("good:s1");
    const first = Array.from({ length: 50 }, () => b.hit(mine));
    await until(() => b.gate.stats().parked === 49, "49 waiters parked");
    leaderGate.open(); // the leader succeeds; the 49 are released as a cohort and block on their own provider calls
    await until(() => b.world.calls.total === 50, "leader + 49 released members authenticating");
    // (i) ten LATE same-set arrivals while the cohort is authenticating: they join, there is still exactly one flight
    const late = Array.from({ length: 10 }, () => b.hit(mine));
    await until(() => b.world.calls.total === 60, "ten joiners authenticating");
    // (ii) ten requests that share ONLY the access handle: they must park, not open a second flight
    const overlap = Array.from({ length: 10 }, (_, i) => b.hit({ ...mine, [R]: `other-${i}` }));
    await until(() => b.gate.stats().parked === 10, "ten overlapping requests parked");
    expect(b.gate.stats().flights).toBe(1);
    expect(b.world.calls.total).toBe(60); // none of the overlapping requests authenticated while the cohort was in flight
    b.world.sessions.delete("s1"); // revoked before the members' calls answer
    memberGate.open();
    const all = await Promise.all([...first, ...late, ...overlap]);
    expect(tally(all)).toEqual({ 200: 1, 401: 59, 429: 10 }); // the leader; 49 + 10 members failed once; the 10 parked ones were refused by T
    expect(b.world.calls.total).toBe(60); // 1 + 49 + 10, exactly: the overlapping ten never authenticated
    expect(b.gate.stats().flights).toBe(0);
    expect(b.gate.stats().parked).toBe(0);
    expect(b.gate.stats().good).not.toContain(b.gate.handleOf("a", "good:s1"));
    expect(b.world.maxConcurrent()).toBe(59); // the 49 released + 10 joiners were in flight together (the leader had finished): they share one credential, by design
  });

  it("REGRESSION (150 parallel): at most 1 + 100 attempts, a full cohort refuses newcomers, and nothing is admitted after the first failure", async () => {
    const b = await build();
    const leaderGate = deferred();
    const gates = new Map<number, Gate>();
    const gateFor = (n: number) => gates.get(n) ?? gates.set(n, deferred()).get(n)!;
    b.world.before = async (n) => { await (n === 1 ? leaderGate : gateFor(n)).promise; };
    const mine = acc("good:s1");
    const rs = Array.from({ length: 150 }, () => b.hit(mine));
    await until(() => b.gate.stats().parked === 100, "100 waiters parked");
    leaderGate.open();
    await until(() => b.world.calls.total === 101, "leader + 100 released members");
    const late = await Promise.all(Array.from({ length: 5 }, () => b.hit(mine)));
    expect(tally(late)).toEqual({ 429: 5 }); // the cohort is at its cap
    expect((await Promise.all([b.hit(mine), b.hit(mine)])).map((r) => r.headers["retry-after"])).toEqual(["1", "1"]); // a short wait, not the 60 s window
    expect(b.world.calls.total).toBe(101);
    b.world.sessions.delete("s1");
    gateFor(2).open(); // one member observes the revocation: the flight is closed to newcomers
    await until(() => b.gate.stats().failures[b.gate.handleOf("a", "good:s1")] === 1, "first failure observed");
    const afterFirst = await b.hit(mine);
    expect(afterFirst.statusCode).toBe(401); // a free copy: no authentication
    expect(b.world.calls.total).toBe(101);
    for (const g of gates.values()) g.open();
    const done = await Promise.all(rs);
    expect(tally(done)).toEqual({ 200: 1, 401: 100, 429: 49 });
    expect(b.world.calls.total).toBe(101); // 1 + Wc, never more
  });

  it("a flight that was released at the leader's success would let an overlapping request open a second one (the rule that prevents it)", async () => {
    const b = await build();
    const leaderGate = deferred();
    const memberGate = deferred();
    b.world.before = async (n) => { await (n === 1 ? leaderGate : memberGate).promise; };
    const reqs = [b.hit(acc("good:s1")), b.hit(acc("good:s1"))];
    await until(() => b.gate.stats().parked === 1, "one waiter");
    leaderGate.open();
    await until(() => b.world.calls.total === 2, "member authenticating");
    const overlap = b.hit({ [A]: "good:s1", [R]: "other" });
    await until(() => b.gate.stats().parked === 1, "overlap parked");
    expect(b.gate.stats().flights).toBe(1);
    memberGate.open();
    await Promise.all([...reqs, overlap]);
  });

  it("a known-good mark lasts goodTtlMs (5 minutes): not the 60 s window, and not for ever (a success refreshes it, so two timelines)", async () => {
    const age = async (ms: number) => {
      let t = 0;
      const b = await build({ params: { newFailingHandles: 1 }, now: () => t });
      expect((await b.hit(acc("good:s1"))).statusCode).toBe(200); // marked at t = 0
      t = ms;
      await b.hit(acc("bad-1")); // a fresh failure window: F = 1, full
      expect((await b.hit(acc("brand-new"))).statusCode).toBe(429); // an unknown credential is refused
      return (await b.hit(acc("good:s1"))).statusCode;
    };
    expect(await age(299_000)).toBe(200); // older than the 60 s window, younger than 5 minutes: still known-good
    expect(await age(301_000)).toBe(429); // older than 5 minutes: unknown again
  });

  it("ONE known-good handle among two is enough for the F exemption (a good access cookie with an unknown refresh cookie passes while F is full)", async () => {
    const b = await build({ params: { newFailingHandles: 2 } });
    expect((await b.hit(acc("good:s1"))).statusCode).toBe(200); // marks the access handle
    await b.hit(pair("bad-a", "bad-r")); // F = 2: full
    expect((await b.hit(acc("brand-new"))).statusCode).toBe(429); // an unknown credential alone is refused
    expect((await b.hit(pair("good:s1", "rf-unknown"))).statusCode).toBe(200); // the good handle exempts the pair
    expect((await b.hit(pair("brand-new-2", "rf-unknown-2"))).statusCode).toBe(429); // two unknown handles are refused
  });

  it("known-good is exempt from the F check only: it still goes through single-flight, an unknown credential is refused, T still blocks", async () => {
    const b = await build({ params: { newFailingHandles: 2 } });
    expect((await b.hit(acc("good:s1"))).statusCode).toBe(200);
    await b.hit(pair("bad-a", "bad-r")); // F = 2: reached
    expect((await b.hit(acc("brand-new"))).statusCode).toBe(429);
    const hold = deferred();
    const base = b.world.calls.total;
    b.world.before = async (n) => { if (n === base + 1) await hold.promise; };
    const rs = Array.from({ length: 4 }, () => b.hit(acc("good:s1")));
    await until(() => b.gate.stats().parked === 3, "known-good parks behind its leader (single-flight applies)");
    hold.open();
    expect(tally(await Promise.all(rs))).toEqual({ 200: 4 });
    // a handle with T >= 3 stays blocked even though its session is valid again
    const c = await build();
    expect((await c.hit(acc("good:s1"))).statusCode).toBe(200);
    c.world.sessions.delete("s1");
    for (let i = 0; i < 3; i++) await c.hit(acc("good:s1"));
    c.world.sessions.add("s1");
    expect((await c.hit(acc("good:s1"))).statusCode).toBe(429);
  });
});

describe("known-good detection uses the guard's authVia, never the Set-Cookie alone", () => {
  it("an access success marks only the access handle; a garbage refresh riding along is not marked", async () => {
    const { hit, gate } = await build();
    await hit(pair("good:s1", "garbage"));
    const good = gate.stats().good;
    expect(good).toContain(gate.handleOf("a", "good:s1"));
    expect(good).not.toContain(gate.handleOf("r", "garbage"));
  });

  it("a refresh ROTATE marks the refresh that worked and both issued values, not the stale access value", async () => {
    const { hit, gate, world } = await build();
    const r = await hit(pair("expired", "rf-1"));
    expect(r.statusCode).toBe(200);
    const good = gate.stats().good;
    expect(good).toContain(gate.handleOf("r", "rf-1"));
    expect(good).toContain(gate.handleOf("r", world.rf.current)); // issued in the reply
    expect(good).toContain(gate.handleOf("a", "good:s1")); // issued in the reply
    expect(good).not.toContain(gate.handleOf("a", "expired"));
  });

  it("the refresh GRACE window (no new refresh cookie) marks the refresh that worked and the issued access value only", async () => {
    const { hit, gate } = await build();
    await hit(pair("expired", "rf-1")); // rotates: rf-1 becomes the previous token
    const r = await hit(pair("expired-2", "rf-1")); // grace
    expect(r.statusCode).toBe(200);
    expect(r.cookies.filter((c) => c.value !== "").map((c) => c.name)).toEqual([A]); // no new refresh cookie
    expect(gate.stats().good).not.toContain(gate.handleOf("a", "expired-2"));
    expect(gate.stats().good).toContain(gate.handleOf("r", "rf-1"));
  });

  it("an OK outcome with no authVia marks nothing, and a failure marks nothing", async () => {
    const world = makeWorld();
    const app = Fastify();
    await app.register(cookie);
    const gate = createCanvasAuthGate();
    open.push(app);
    await app.register(async (scope) => {
      registerCanvasAuthGate(scope, gate);
      // a guard that authenticates WITHOUT saying how (no authVia) and issues a cookie: nothing about it may be marked known-good
      scope.get("/x", { preHandler: [makeCanvasWithAuth(async (req, reply) => { req.user = { id: "u" } as never; reply.setCookie(A, "issued-value", { path: "/" }); })] }, async () => ({ ok: true }));
    });
    const sent = await app.inject({ method: "GET", url: "/x", cookies: acc("anything") });
    expect(sent.statusCode).toBe(200);
    expect(sent.cookies.map((c) => c.name)).toContain(A); // the cookie really was issued, so there was something to (wrongly) mark
    expect(gate.stats().good).toEqual([]);
    const failing = await build({ world });
    await failing.hit(pair("bad-a", "bad-r"));
    expect(failing.gate.stats().good).toEqual([]);
  });
});

describe("overlapping credentials: one flight owns every handle on the request", () => {
  it("shares only the ACCESS handle: 3 leaders and 6 calls, then T blocks the rest; never two attempts on one handle at once", async () => {
    const { hit, world, gate } = await build();
    const hold = deferred();
    world.before = async (n) => { if (n === 1) await hold.promise; };
    const rs = Array.from({ length: 10 }, (_, i) => hit(pair("bad-a", `bad-r${i}`)));
    await until(() => gate.stats().parked === 9, "nine overlapping requests parked");
    hold.open();
    expect(tally(await Promise.all(rs))).toEqual({ 401: 3, 429: 7 });
    expect(world.calls.total).toBe(6);
    expect(world.maxConcurrent()).toBe(1);
  });

  it("shares only the REFRESH handle: 3 leaders and 6 calls, then 429", async () => {
    const { hit, world, gate } = await build();
    const hold = deferred();
    world.before = async (n) => { if (n === 1) await hold.promise; };
    const rs = Array.from({ length: 10 }, (_, i) => hit(pair(`bad-a${i}`, "bad-r")));
    await until(() => gate.stats().parked === 9, "nine overlapping requests parked");
    hold.open();
    expect(tally(await Promise.all(rs))).toEqual({ 401: 3, 429: 7 });
    expect(world.calls.total).toBe(6);
    expect(world.maxConcurrent()).toBe(1);
  });

  it("disjoint credentials: only the unknown-leader cap (4) authenticate at once, the extra 5 are refused", async () => {
    const { hit, world } = await build({ params: { unknownLeaders: 4 } });
    const hold = deferred();
    world.before = async () => { await hold.promise; };
    const rs = Array.from({ length: 9 }, (_, i) => hit(pair(`bad-a${i}`, `bad-r${i}`)));
    await until(() => world.calls.total === 4, "four leaders authenticating");
    await tick();
    expect(world.calls.total).toBe(4);
    hold.open();
    expect(tally(await Promise.all(rs))).toEqual({ 401: 4, 429: 5 });
    expect(world.calls.total).toBe(8); // 4 leaders x (validate + refresh)
  });

  it("a request that overlaps two different flights waits for them and authenticates nothing while they are live", async () => {
    const { hit, world, gate } = await build();
    const hold = deferred();
    world.before = async () => { await hold.promise; };
    const one = hit(acc("bad-x"));
    const two = hit({ [R]: "bad-y" });
    await until(() => world.calls.total === 2, "two flights");
    const overlap = hit(pair("bad-x", "bad-y"));
    await until(() => gate.stats().parked === 1, "the overlapping request parked");
    expect(world.calls.total).toBe(2);
    hold.open();
    expect((await Promise.all([one, two, overlap])).map((r) => r.statusCode)).toEqual([401, 401, 401]);
  });
});

describe("a stalled or failing provider cannot cause an unbounded authentication fan-out", () => {
  it.each([
    [50, { 200: 1, 503: 49 }],
    [150, { 200: 1, 503: 100, 429: 49 }],
  ])("a stalled leader, %i parallel: every waiter that was parked gets 503 + Retry-After 1, the excess gets 429, and NONE of them authenticates", async (n, statuses) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { hit, world, gate } = await build({ params: { waitMs: 2_000 } });
    const never = deferred();
    world.before = async () => { await never.promise; };
    const rs = Array.from({ length: n }, () => hit(acc("good:s1")));
    await until(() => gate.stats().parked === Math.min(n - 1, 100), "waiters parked");
    await vi.advanceTimersByTimeAsync(2_000);
    await until(() => gate.stats().parked === 0, "waiters released");
    expect(world.calls.total).toBe(1); // only the leader's own (stalled) call
    never.open();
    const done = await Promise.all(rs);
    expect(tally(done)).toEqual(statuses);
    expect(done.filter((r) => r.statusCode === 503).every((r) => r.headers["retry-after"] === "1")).toBe(true);
    expect(world.calls.total).toBe(1);
  });

  it("over a 60 s stall with a request every 100 ms (600 requests) there is at most one new leader per 10 s: at most 7 calls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { hit, world } = await build({ params: { waitMs: 2_000 } });
    const never = deferred();
    world.before = async () => { await never.promise; };
    const pending: ReturnType<Built["hit"]>[] = [];
    for (let i = 0; i < 600; i++) {
      pending.push(hit(pair("bad-a", "bad-r")));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(world.calls.total).toBeLessThanOrEqual(7); // one call per hung leader: 60 s / the 10 s flight TTL (a 5 s TTL would make 12)
    expect(world.calls.total).toBeGreaterThanOrEqual(5); // the TTL does let a new leader in, so a credential is never stuck for ever
    never.open();
    await Promise.allSettled(pending);
  });

  it("a provider that throws: the leader's fault is a 500 (the app's error handler, as without the gate), the parked waiters a 503 + Retry-After 1 without authenticating; the CREDENTIAL is not blamed", async () => {
    const { hit, world, gate } = await build();
    const hold = deferred();
    world.before = async (n) => { if (n === 1) await hold.promise; };
    world.throwAt = (n) => n === 1;
    const rs = Array.from({ length: 6 }, () => hit(acc("good:s1")));
    await until(() => gate.stats().parked === 5, "waiters parked");
    hold.open();
    const done = await Promise.all(rs);
    expect(tally(done)).toEqual({ 500: 1, 503: 5 });
    // The leader RAN authentication and the provider threw: the error is rethrown and Fastify's error handler answers it (500), which
    // is exactly what happens without the gate (in production that handler also logs it and reports it to Sentry, once).
    const leader = done.find((r) => r.statusCode === 500)!;
    expect(leader.headers["retry-after"]).toBeUndefined();
    expect(cleared(leader)).toEqual([]); // a fault never signs anybody out
    // A waiter never ran authentication: nothing failed on its behalf, so the gate itself answers "try again in a moment".
    for (const r of done.filter((d) => d.statusCode === 503)) {
      expect(r.headers["retry-after"]).toBe("1");
      expect(r.json()).toMatchObject({ statusCode: 503, error: "Service Unavailable" });
      expect(cleared(r)).toEqual([]);
    }
    expect(world.calls.total).toBe(1);
    // a fault is not a refused credential: no failure, no F, and no lock-out once the fault is gone
    expect(gate.stats().failures).toEqual({});
    expect(gate.stats().newFailingHandles).toEqual({});
    expect((await hit(acc("good:s1"))).statusCode).toBe(200);
  });

  it("a provider that throws at the leader: a waiter that shares only ONE cookie (a different credential set) re-enters admission and authenticates, and nothing is counted", async () => {
    const { hit, world, gate } = await build();
    const hold = deferred();
    world.before = async (n) => { if (n === 1) await hold.promise; };
    world.throwAt = (n) => n === 1;
    const leader = hit(acc("good:s1"));
    await until(() => world.calls.total === 1, "the leader's provider call is in flight");
    const overlap = hit(pair("good:s1", "rf-1")); // shares the access cookie, so it must not authenticate beside the leader
    await until(() => gate.stats().parked === 1, "the overlapping request is parked");
    expect(world.calls.total).toBe(1);
    hold.open();
    const [a, b] = await Promise.all([leader, overlap]);
    expect(a.statusCode).toBe(500); // the leader's fault
    expect(b.statusCode).toBe(200); // not 503: it re-entered, became its own leader and authenticated
    expect(world.calls.total).toBe(2);
    expect(gate.stats().failures).toEqual({});
    expect(gate.stats().newFailingHandles).toEqual({});
    expect(gate.stats().flights).toBe(0);
  });

  it("a parked waiter released into a FULL cohort gets 429 + Retry-After 1 (a short wait, not the 60 s window), like a request that finds the cohort full", async () => {
    const { hit, world, gate } = await build({ params: { waiters: 20, cohort: 2 } });
    const hold = deferred();
    world.before = async (n) => { if (n === 1) await hold.promise; };
    const rs = Array.from({ length: 6 }, () => hit(acc("good:s1")));
    await until(() => gate.stats().parked === 5, "five waiters parked");
    hold.open();
    const done = await Promise.all(rs);
    expect(tally(done)).toEqual({ 200: 3, 429: 3 }); // the leader and a cohort of 2; the other 3 were parked past its cap
    expect(world.calls.total).toBe(3); // the 429s never authenticated
    for (const r of done.filter((d) => d.statusCode === 429)) expect(r.headers["retry-after"]).toBe("1");
  });

  it("a fault that repeats (the database is down for a while) never locks a VALID session out afterwards, and never clears its known-good mark", async () => {
    const { hit, world, gate } = await build();
    expect((await hit(acc("good:s1"))).statusCode).toBe(200);
    const mark = gate.handleOf("a", "good:s1");
    expect(gate.stats().good).toContain(mark);
    world.throwAt = () => true; // the outage
    for (let i = 0; i < 6; i++) expect((await hit(acc("good:s1"))).statusCode).toBe(500); // never 429, however many
    expect(gate.stats().good).toContain(mark);
    expect(gate.stats().failures).toEqual({});
    world.throwAt = null; // the database is back: the very next request works
    expect((await hit(acc("good:s1"))).statusCode).toBe(200);
  });

  it("a request refused BEFORE authentication (a 415 from an earlier preHandler) never takes a flight: a sibling is not parked behind it", async () => {
    const { hit, gate, world } = await build();
    const both = await Promise.all([hit(acc("good:s1"), "10.0.0.1", "/early"), hit(acc("good:s1"), "10.0.0.1", "/early")]);
    expect(tally(both)).toEqual({ 415: 2 }); // no 503: nobody waited on a leader that was never going to authenticate
    expect(gate.stats().flights).toBe(0);
    expect(gate.stats().failures).toEqual({});
    expect(world.calls.total).toBe(0);
    expect((await hit(acc("good:s1"))).statusCode).toBe(200);
  });

  it("a bug inside the gate fails open: the request carries on to withAuth, and the log line holds no cookie data", async () => {
    const logs: unknown[] = [];
    let boom = false;
    const b = await build({ log: { error: (o) => logs.push(o) }, now: () => { if (boom) throw new Error("clock failed"); return Date.now(); } });
    boom = true;
    const r = await b.hit(acc("good:s1"));
    boom = false;
    expect(r.statusCode).toBe(200);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("good:s1");
  });
});

/** A real listening server plus raw sockets: for what `inject` cannot do (a client that leaves, a body that trickles in). */
async function server(b: Built) {
  await b.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (b.app.server.address() as net.AddressInfo).port;
  const raw = (cookie: string, path = "/p") => {
    const s = net.connect(port, "127.0.0.1");
    s.on("error", () => {});
    s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`);
    return s;
  };
  /** A POST whose body is not finished: the headers promise 7 bytes and only `first` is sent; `finish()` sends the rest. */
  const trickle = (cookie: string, first = '{"a"') => {
    const body = '{"a":1}';
    const s = net.connect(port, "127.0.0.1");
    const chunks: string[] = [];
    s.setEncoding("utf8");
    s.on("data", (d: string) => chunks.push(d));
    s.on("error", () => {});
    s.write(`POST /body HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${first}`);
    return { socket: s, finish: () => s.write(body.slice(first.length)), reply: () => chunks.join("") };
  };
  /** The server's side of connection `i` has CLOSED and everything listening to that has run (the request's and the response's `close`).
   *  Not `socket.destroyed` or `socket.closed`: a net socket sets those a libuv phase BEFORE it emits `close`, which would let a test
   *  look at the state too soon (that is how a "slot freed on close" mutation once passed this test). */
  const closedConns = new Set<number>();
  let seen = 0;
  b.app.server.on("connection", (c) => {
    const i = seen++;
    c.once("close", () => setImmediate(() => closedConns.add(i))); // the whole `close` emit is synchronous: by the next turn all listeners have run
  });
  const gone = (i: number) => until(() => closedConns.has(i), "the server saw the disconnect");
  /** `n` raw requests have had their headers parsed by the server (the body of a trickled one may still be on the wire). */
  let parsed = 0;
  b.app.server.on("request", () => parsed++);
  const headersSeen = (n: number) => until(() => parsed >= n, `${n} request(s) reached the server`);
  return { raw, trickle, gone, headersSeen };
}

describe("client disconnects (a real server and raw sockets)", () => {
  it("a leader whose client disconnects still authenticates: its slot is held until then, waiters get the REAL outcome, the failure is recorded", async () => {
    const b = await build({ params: { unknownLeaders: 1 } });
    const { raw, gone } = await server(b);
    const hold = deferred();
    b.world.before = async (n) => { if (n === 1) await hold.promise; };
    const sock = raw(`${A}=bad-x`);
    await until(() => b.world.calls.total === 1, "the leader's authentication started");
    sock.destroy(); // the client is gone, the chain is not cancelled
    await gone(0);
    expect(b.gate.stats().unknownLeaders["127.0.0.1"]).toBe(1); // the slot stays
    expect((await b.hit(acc("another-unknown"), "127.0.0.1")).statusCode).toBe(429); // so a second unknown credential is refused
    const waiter = b.hit(acc("bad-x"), "127.0.0.1");
    await until(() => b.gate.stats().parked === 1, "waiter parked");
    hold.open();
    expect((await waiter).statusCode).toBe(401); // the leader's real outcome, as a free copy
    await until(() => Object.keys(b.gate.stats().unknownLeaders).length === 0, "slot released");
    expect(b.gate.stats().failures[b.gate.handleOf("a", "bad-x")]).toBe(1); // recorded although the client left
  });

  it("failures are recorded despite an abort: the attacker cannot avoid being counted by disconnecting", async () => {
    const b = await build();
    const { raw } = await server(b);
    const gates = new Map<number, Gate>();
    const gateFor = (n: number) => gates.get(n) ?? gates.set(n, deferred()).get(n)!;
    b.world.before = async (n) => { await gateFor(n).promise; };
    for (let i = 1; i <= 3; i++) {
      const sock = raw(`${A}=bad-x`);
      await until(() => b.world.calls.total === i, `attempt ${i} started`);
      sock.destroy();
      gateFor(i).open();
      await until(() => (b.gate.stats().failures[b.gate.handleOf("a", "bad-x")] ?? 0) === i, `attempt ${i} recorded`);
    }
    expect((await b.hit(acc("bad-x"), "127.0.0.1")).statusCode).toBe(429);
    expect(b.world.calls.total).toBe(3);
  });

  it("a parked waiter whose client disconnected does not authenticate when it is released", async () => {
    const b = await build();
    const { raw, gone } = await server(b);
    const hold = deferred();
    b.world.before = async (n) => { if (n === 1) await hold.promise; };
    const leader = b.hit(acc("good:s1"), "127.0.0.1");
    await until(() => b.world.calls.total === 1, "leader authenticating");
    const sock = raw(`${A}=good:s1`);
    await until(() => b.gate.stats().parked === 1, "the raw waiter parked");
    sock.destroy();
    await gone(0);
    hold.open();
    expect((await leader).statusCode).toBe(200);
    await until(() => b.gate.stats().parked === 0 && b.gate.stats().flights === 0, "everything settled");
    expect(b.world.calls.total).toBe(1); // the dropped waiter was released but never authenticated
  });

  it("premise: a client that disconnects before the reply is written does NOT trigger onResponse, while onSend still runs", async () => {
    const sends: number[] = [];
    const responses: number[] = [];
    const app = Fastify();
    open.push(app);
    const release = deferred();
    let reached = false;
    let closed = false; // the server's connection has emitted `close` and every listener of it has run
    await app.register(async (scope) => {
      scope.addHook("onSend", async (_req, _reply, payload) => { sends.push(1); return payload; });
      scope.addHook("onResponse", async () => { responses.push(1); });
      scope.get("/hold", async () => { reached = true; await release.promise; return { ok: true }; });
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    app.server.once("connection", (c) => c.once("close", () => setImmediate(() => { closed = true; })));
    const port = (app.server.address() as net.AddressInfo).port;
    const s = net.connect(port, "127.0.0.1");
    s.on("error", () => {});
    s.write("GET /hold HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    await until(() => reached, "the handler is running");
    s.destroy();
    // Not `socket.destroyed`: that turns true a step BEFORE the close reaches the response, and until it has, Fastify can still see
    // the response finish and would run onResponse (this is the timing the premise depends on: an abort that has fully propagated).
    await until(() => closed, "the server saw the client leave");
    release.open();
    await until(() => sends.length === 1, "onSend ran for the abandoned request");
    await new Promise((r) => setTimeout(r, 100)); // a negative has to be waited for: onResponse would have run by now
    expect(sends).toHaveLength(1);
    expect(responses).toHaveLength(0);
  });
});

describe("admission happens AFTER the body is read: a slow or trickling body never holds a credential's flight", () => {
  it("a POST whose body is still arriving takes no flight: sibling requests authenticate at once, the POST authenticates when its body completes", async () => {
    const b = await build();
    const { trickle, headersSeen } = await server(b);
    const t = trickle(`${A}=good:s1`);
    await headersSeen(1); // the request is known to the server; its body is still on the wire
    // siblings of the SAME credential are not parked behind the slow upload (they would have been 503 after 2 s)
    expect(tally(await Promise.all(Array.from({ length: 5 }, () => b.hit(acc("good:s1"), "127.0.0.1"))))).toEqual({ 200: 5 });
    expect(b.gate.stats().flights).toBe(0);
    expect(b.gate.stats().parked).toBe(0);
    const before = b.world.calls.total;
    expect(before).toBe(5); // the upload has not authenticated: its body is incomplete
    t.finish();
    await until(() => /200 OK/.test(t.reply()), "the upload answered");
    expect(b.world.calls.total).toBe(before + 1);
    t.socket.destroy();
  });

  it("a trickling body holds no unknown-leader slot: another unknown credential is not refused because of it", async () => {
    const b = await build({ params: { unknownLeaders: 1 } });
    const { trickle, headersSeen } = await server(b);
    const t = trickle(`${A}=bad-slow`);
    await headersSeen(1);
    expect((await b.hit(acc("bad-other"), "127.0.0.1")).statusCode).toBe(401); // with the slot taken at onRequest this was a 429
    t.socket.destroy();
  });

  it("the credential is checked again when the body completes: failures recorded meanwhile block the late request without authenticating", async () => {
    const b = await build();
    const { trickle, headersSeen } = await server(b);
    const t = trickle(`${A}=bad-slow`);
    await headersSeen(1);
    for (let i = 0; i < 3; i++) expect((await b.hit(acc("bad-slow"), "127.0.0.1")).statusCode).toBe(401); // T reaches 3 while the body trickles
    expect(b.world.calls.total).toBe(3);
    t.finish();
    await until(() => /429/.test(t.reply()), "the late request refused");
    expect(b.world.calls.total).toBe(3); // refused before authentication
    t.socket.destroy();
  });

  it("a credential that is ALREADY blocked is refused before its body is read (the early check still exists)", async () => {
    const b = await build();
    const { trickle } = await server(b);
    for (let i = 0; i < 3; i++) await b.hit(acc("bad-x"), "127.0.0.1");
    const t = trickle(`${A}=bad-x`); // the body is never finished
    await until(() => /429/.test(t.reply()), "refused without waiting for the body");
    expect(b.world.calls.total).toBe(3);
    t.socket.destroy();
  });

  it("overlapping credentials: a body that completes while an overlapping flight is live waits for it (admission is evaluated at completion, not at arrival)", async () => {
    const b = await build();
    const { trickle, headersSeen } = await server(b);
    const hold = deferred();
    b.world.before = async (n) => { if (n === 1) await hold.promise; };
    const leader = b.hit(pair("bad-a", "bad-r1"), "127.0.0.1");
    await until(() => b.world.calls.total === 1, "the leader authenticating");
    const t = trickle(`${A}=bad-a; ${R}=bad-r2`); // shares only the access handle
    await headersSeen(1);
    expect(b.gate.stats().parked).toBe(0); // arrival alone parks nothing
    t.finish();
    await until(() => b.gate.stats().parked === 1, "the completed body waits behind the overlapping flight");
    hold.open();
    expect((await leader).statusCode).toBe(401);
    await until(() => /401/.test(t.reply()), "the overlapping request answered after the flight ended");
    t.socket.destroy();
  });

  it("cohort lifecycle: a request whose body has not completed neither joins the cohort nor keeps the flight open", async () => {
    const b = await build();
    const { trickle, headersSeen } = await server(b);
    const leaderGate = deferred();
    b.world.before = async (n) => { if (n === 1) await leaderGate.promise; };
    const first = Array.from({ length: 4 }, () => b.hit(acc("good:s1"), "127.0.0.1"));
    await until(() => b.gate.stats().parked === 3, "three waiters parked behind the leader");
    const t = trickle(`${A}=good:s1`);
    await headersSeen(1);
    expect(b.gate.stats().parked).toBe(3); // the trickling request is not parked either
    leaderGate.open();
    expect(tally(await Promise.all(first))).toEqual({ 200: 4 });
    expect(b.gate.stats().flights).toBe(0); // the cohort drained and the flight ended although a body is still on the wire
    t.finish();
    await until(() => /200 OK/.test(t.reply()), "the late body authenticated as a fresh leader");
    expect(b.world.calls.total).toBe(5);
    expect(b.gate.stats().flights).toBe(0);
    t.socket.destroy();
  });
});

describe("provider faults and credential failures stay distinguishable inside one cohort", () => {
  it("a fault does not close the cohort, count against T/F or clear the Good mark; a refused credential does all three, exactly", async () => {
    const b = await build();
    const leaderGate = deferred();
    const gates = new Map<number, Gate>();
    const gateFor = (n: number) => gates.get(n) ?? gates.set(n, deferred()).get(n)!;
    b.world.before = async (n) => { await (n === 1 ? leaderGate : gateFor(n)).promise; };
    b.world.throwAt = (n) => n === 2; // one released member hits a provider fault
    const mine = acc("good:s1");
    const h = b.gate.handleOf("a", "good:s1");
    const first = Array.from({ length: 4 }, () => b.hit(mine));
    await until(() => b.gate.stats().parked === 3, "three waiters parked");
    leaderGate.open();
    await until(() => b.world.calls.total === 4, "the cohort is authenticating");
    expect(b.gate.stats().good).toContain(h); // the leader's success marked the credential
    gateFor(2).open(); // the fault
    for (let i = 0; i < 20; i++) await tick(); // let the faulting member's rejection settle (all microtasks: nothing observable to wait for)
    // after the fault: T and F untouched, the mark kept, the cohort still open
    expect(b.gate.stats().failures).toEqual({});
    expect(b.gate.stats().newFailingHandles).toEqual({});
    expect(b.gate.stats().good).toContain(h);
    const joiner = b.hit(mine);
    await until(() => b.world.calls.total === 5, "a late joiner is admitted after a fault (the cohort is open)");
    b.world.sessions.delete("s1"); // from now on the credential is refused
    gateFor(3).open();
    await until(() => b.gate.stats().failures[h] === 1, "the refusal is counted");
    // after the first REFUSAL: T = 1, F = 1, the mark gone, the cohort closed (a same-set arrival gets a free copy, no authentication)
    expect(Object.values(b.gate.stats().newFailingHandles)).toEqual([1]);
    expect(b.gate.stats().good).not.toContain(h);
    const afterRefusal = await b.hit(mine);
    expect(afterRefusal.statusCode).toBe(401);
    expect(b.world.calls.total).toBe(5);
    expect(b.gate.stats().failures[h]).toBe(1); // a free copy is not an attempt
    for (const g of gates.values()) g.open();
    const done = await Promise.all([...first, joiner]);
    // exact: the leader 200; the member whose call threw 500 (signed nobody out); the three whose credential was refused 401
    expect(tally(done)).toEqual({ 200: 1, 500: 1, 401: 3 });
    expect(cleared(done.find((r) => r.statusCode === 500)!)).toEqual([]);
    for (const r of done.filter((d) => d.statusCode === 401)) expect(cleared(r)).toEqual([A, R, "ss-session-only"]);
    expect(b.gate.stats().failures[h]).toBe(3); // the three refused attempts, never the fault
    expect(Object.values(b.gate.stats().newFailingHandles)).toEqual([1]); // one handle, once
    expect(b.gate.stats().flights).toBe(0);
  });
});

describe("recording the outcome fails open like admission does: a bug in the gate never turns a request into a failure", () => {
  const make = async (extra: Parameters<typeof build>[0] = {}) => {
    const flag = { boom: false };
    const logs: unknown[] = [];
    const b = await build({ ...extra, log: { error: (o) => logs.push(o) }, now: () => { if (flag.boom) throw new Error("clock failed"); return Date.now(); } });
    return { b, flag, logs };
  };

  it("a failure while recording a SUCCESS: the request is still a 200, nothing is logged but the message", async () => {
    const { b, flag, logs } = await make();
    b.world.before = async () => { flag.boom = true; }; // the gate's clock breaks while authentication runs, so `record` throws
    const r = await b.hit(acc("good:s1"));
    flag.boom = false;
    expect(r.statusCode).toBe(200);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("good:s1");
    expect(b.gate.stats().flights).toBe(0); // the flight did not stay open until its TTL
  });

  it("a failure while recording a REFUSAL: the real 401 is answered, and a parked waiter is released at once (503), not held until the TTL", async () => {
    const { b, flag } = await make();
    const hold = deferred();
    b.world.before = async (n) => { if (n === 1) { await hold.promise; flag.boom = true; } };
    const leader = b.hit(acc("bad-x"));
    await until(() => b.world.calls.total === 1, "the leader is authenticating");
    const waiter = b.hit(acc("bad-x"));
    await until(() => b.gate.stats().parked === 1, "a waiter is parked");
    hold.open();
    const done = await Promise.all([leader, waiter]);
    flag.boom = false;
    expect(done[0].statusCode).toBe(401); // what the guard answered, not a 500 from the gate
    expect(done[1].statusCode).toBe(503); // released with "try again", not waiting 10 s for the TTL
    expect(b.gate.stats().flights).toBe(0);
    expect(b.gate.stats().unknownLeaders).toEqual({});
  });

  it("a failure while marking the cookies the reply issued (onSend): the reply still goes out", async () => {
    const { b, flag } = await make();
    const route = b.hit(pair("expired", "rf-1"), "10.0.0.1", "/slow"); // a rotation: the reply carries new cookies, and the handler is held
    await until(() => b.world.calls.refresh === 1, "the refresh ran");
    for (let i = 0; i < 20; i++) await tick(); // the handler is now waiting; authentication and recording are done
    flag.boom = true; // from here, any use of the gate's clock throws: onSend's marking is the next one
    b.slow.open();
    const r = await route;
    flag.boom = false;
    expect(r.statusCode).toBe(200);
  });
});

describe("the work bound (asserted, with the measured maximum printed)", () => {
  /**
   * The adversary that gets the most calls out of one address. Phase 1: F - 1 fresh credentials, each used three times in a row (so T
   * never stops one before its three attempts). Phase 2: while F is still open, a burst of 3 x Lu fresh credentials started together
   * with the provider held, so every one the leader cap lets in is admitted before any failure is recorded (the F overshoot the bound
   * allows for). Phase 3: more fresh credentials, which F must now refuse.
   */
  async function adversary(params: Partial<GateParams> & { newFailingHandles: number; unknownLeaders: number }) {
    const { newFailingHandles: F, unknownLeaders: Lu } = params;
    const b = await build({ params });
    const codes: number[] = [];
    for (let j = 0; j < F - 1; j++) for (let k = 0; k < 3; k++) codes.push((await b.hit(acc(`bad-${j}`))).statusCode);
    const afterPhase1 = b.world.calls.total;
    const hold = deferred();
    b.world.before = async () => { await hold.promise; };
    const burst = Array.from({ length: Lu * 3 }, (_, i) => b.hit(acc(`burst-${i}`)));
    await until(() => b.world.calls.total - afterPhase1 === Lu, "Lu leaders are authenticating");
    await tick();
    const admittedAtOnce = b.world.calls.total - afterPhase1; // the rest were refused by the leader cap, not parked
    hold.open();
    codes.push(...(await Promise.all(burst)).map((r) => r.statusCode));
    b.world.before = null;
    const afterBurst = b.world.calls.total;
    for (let j = 0; j < 10; j++) codes.push((await b.hit(acc(`late-${j}`))).statusCode);
    return { calls: b.world.calls.total, afterPhase1, admittedAtOnce, lateCalls: b.world.calls.total - afterBurst, refused: codes.filter((c) => c === 429).length };
  }

  it("never-valid credentials cost at most 3 x (F + 2 x Lu) calls: 54 with F = 10 and Lu = 4, 1,284 at the defaults; the limits are what stops the adversary", async () => {
    const small = await adversary({ newFailingHandles: 10, unknownLeaders: 4, waiters: 5, cohort: 5 });
    const big = await adversary({ newFailingHandles: 300, unknownLeaders: 64 });
    console.info(`[canvas auth gate] measured never-valid calls: ${small.calls} (bound 54), ${big.calls} (bound 1284)`);
    for (const [r, F, Lu] of [[small, 10, 4], [big, 300, 64]] as const) {
      expect(r.calls).toBeLessThanOrEqual(3 * (F + 2 * Lu));
      expect(r.afterPhase1).toBe(3 * (F - 1)); // the adversary really spent F - 1 credentials three times each
      expect(r.calls).toBe(r.afterPhase1 + Lu); // the burst added exactly the leaders the cap admits, and nothing after it did
      expect(r.admittedAtOnce).toBe(Lu); // never more than Lu unknown leaders authenticating together
      expect(r.lateCalls).toBe(0); // F stops the next credential outright
      expect(r.refused).toBeGreaterThanOrEqual(2 * Lu + 10); // the burst's excess and every late credential were refused
    }
    expect(big.calls).toBeGreaterThan(600); // above what 300 two-call requests could ever cost: the defaults' bound is exercised
  }, 60_000); // two adversary runs, the second at the defaults: about 1.5 s alone, 7.3 s once in a loaded full-suite run (the default limit is 5 s)

  it("a session revoked mid-cohort costs at most 1 + Wc attempts (Wc = 5 here: 6)", async () => {
    const b = await build({ params: { waiters: 20, cohort: 5 } });
    const leaderGate = deferred();
    const memberGate = deferred();
    b.world.before = async (n) => { await (n === 1 ? leaderGate : memberGate).promise; };
    const rs = Array.from({ length: 20 }, () => b.hit(acc("good:s1")));
    await until(() => b.gate.stats().parked === 19, "19 parked");
    leaderGate.open();
    await until(() => b.world.calls.total === 6, "leader + 5 members");
    b.world.sessions.delete("s1");
    memberGate.open();
    const done = await Promise.all(rs);
    console.info(`[canvas auth gate] measured revoked-cohort attempts: ${b.world.calls.total} (bound ${1 + 5}); statuses ${JSON.stringify(tally(done))}`);
    expect(b.world.calls.total).toBeLessThanOrEqual(6);
  });
});

describe("the per-user quota still works behind the gate, and the gate leaves everyone else alone", () => {
  it("two signed-in people behind the SAME address have separate allowances; failed authentication uses none", async () => {
    const b = await build({ rate: 2 });
    const ann = acc("good:s1");
    const bob = acc("good:s2");
    for (let i = 0; i < 5; i++) expect((await b.hit(undefined)).statusCode).toBe(401); // anonymous: refused, uses nobody's allowance
    expect([await b.hit(ann), await b.hit(ann), await b.hit(ann)].map((r) => r.statusCode)).toEqual([200, 200, 429]);
    expect([await b.hit(bob), await b.hit(bob), await b.hit(bob)].map((r) => r.statusCode)).toEqual([200, 200, 429]); // bob is not held back by ann
    // authenticated traffic touches no failure counter (the five anonymous requests above only used the anonymous counter)
    expect(b.gate.stats().failures).toEqual({});
    expect(b.gate.stats().newFailingHandles).toEqual({});
  });

  it("requests refused by authentication do not consume another user's allowance", async () => {
    const b = await build({ rate: 1 });
    // with a limit of 1 a limiter that ran BEFORE authentication would key these on the address and refuse the second one
    for (let i = 0; i < 4; i++) expect((await b.hit(acc(`bad-${i}`))).statusCode).toBe(401);
    expect((await b.hit(acc("good:s1"))).statusCode).toBe(200);
    expect((await b.hit(acc("good:s1"))).statusCode).toBe(429);
  });

  it("a sibling route outside the gate's scope, with its own login-style limit, is untouched by the gate", async () => {
    const app = Fastify();
    open.push(app);
    await app.register(cookie);
    await app.register(rateLimit, { global: false });
    const gate = createCanvasAuthGate({ params: { anon: 1 } });
    await app.register(async (scope) => {
      registerCanvasAuthGate(scope, gate);
      scope.get("/inside", async () => ({ ok: true }));
    });
    app.get("/outside", { config: guessLimit(5) }, async () => ({ ok: true }));
    await app.ready();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await app.inject({ method: "GET", url: "/outside", remoteAddress: "10.0.0.9" })).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]); // governed by its own guessLimit(5); the gate (anon = 1) never saw it
    expect((await app.inject({ method: "GET", url: "/inside", remoteAddress: "10.0.0.9" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/inside", remoteAddress: "10.0.0.9" })).statusCode).toBe(429); // the gate is on inside
  });
});

describe("hygiene: nothing secret is kept, logged or trusted", () => {
  it("no raw cookie value appears in any map, counter, log line or response; handles differ between gate instances", async () => {
    const lines: string[] = [];
    const secretA = "SECRET-ACCESS-VALUE-123";
    const secretR = "SECRET-REFRESH-VALUE-456";
    const b = await build({ logger: { level: "debug", stream: { write: (m: string) => lines.push(m) } } });
    const rs = [await b.hit(pair(secretA, secretR)), await b.hit(acc(secretA)), await b.hit(pair("good:s1", secretR))];
    const everything = JSON.stringify(b.gate.stats()) + lines.join("") + rs.map((r) => r.body + JSON.stringify(r.headers)).join("");
    expect(everything).not.toContain(secretA);
    expect(everything).not.toContain(secretR);
    expect(everything).not.toContain("good:s1");
    const other = createCanvasAuthGate();
    expect(other.handleOf("a", secretA)).not.toBe(b.gate.handleOf("a", secretA));
    expect(b.gate.handleOf("a", secretA)).toMatch(/^a:[0-9a-f]{32}$/);
  });

  it("it ignores a spoofed X-Forwarded-For when the app trusts no proxy: the bucket is the address the app reports (this test app sets no trustProxy)", async () => {
    const { hit } = await build({ params: { anon: 2 } });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await hit(undefined, "10.0.0.1", "/p", { "x-forwarded-for": `1.2.3.${i}` })).statusCode);
    expect(codes).toEqual([401, 401, 429, 429]);
  });

  it("the failure maps, the known-good map and the anonymous map stay within their cap, and an evicted handle can simply be retried", async () => {
    const { hit, gate } = await build({ params: { cap: 5, newFailingHandles: 1000, failures: 1 } });
    await hit(pair("bad-a0", "bad-r0"), "10.0.0.1");
    expect((await hit(pair("bad-a0", "bad-r0"), "10.0.0.1")).statusCode).toBe(429); // control: while remembered, one failure is enough here
    for (let i = 1; i < 30; i++) await hit(pair(`bad-a${i}`, `bad-r${i}`), `10.0.${i}.1`);
    const stats = gate.stats();
    expect(Object.keys(stats.failures).length).toBeLessThanOrEqual(5);
    expect(Object.keys(stats.newFailingHandles).length).toBeLessThanOrEqual(5);
    expect((await hit(pair("bad-a0", "bad-r0"), "10.0.0.1")).statusCode).toBe(401); // evicted, so it is a fresh attempt (it was 429 above)
    // the known-good map: 30 distinct valid sessions leave exactly `cap` marks
    const good = await build({ params: { cap: 5 } });
    for (let i = 0; i < 30; i++) {
      good.world.sessions.add(`c${i}`);
      expect((await good.hit(acc(`good:c${i}`), `10.1.${i}.1`)).statusCode).toBe(200);
    }
    expect(good.gate.stats().good).toHaveLength(5);
    // the anonymous map: 30 addresses, no credential anywhere, so every key in the gate is an anonymous counter
    const anon = await build({ params: { cap: 5 } });
    for (let i = 0; i < 30; i++) await anon.hit(undefined, `10.2.${i}.1`);
    expect(anon.gate.stats().keys).toHaveLength(5);
  });
});

describe("provider independence (this is NOT a live Supabase integration)", () => {
  it("with a provider that has no session id and counts remote calls, the same numbers hold: 2 calls for a failing burst, N for a valid one", async () => {
    // A double with Supabase-SHAPED semantics (no sessionId, every attempt is one "remote call"). It proves the gate does not depend on
    // the provider; it does not prove that a real Supabase project works. The repository has no integration test for that provider.
    const b = await build({ world: makeWorld("supabase") });
    const hold = deferred();
    b.world.before = async (n) => { if (n === 1) await hold.promise; };
    const failing = Array.from({ length: 50 }, () => b.hit(pair("bad-a", "bad-r")));
    await until(() => b.gate.stats().parked === 49, "waiters parked");
    hold.open();
    expect(tally(await Promise.all(failing))).toEqual({ 401: 50 });
    expect(b.world.calls.total).toBe(2);
    const base = b.world.calls.total;
    b.world.before = null;
    expect(tally(await Promise.all(Array.from({ length: 20 }, () => b.hit(acc("good:s1")))))).toEqual({ 200: 20 });
    expect(b.world.calls.total - base).toBe(20);
  });
});
