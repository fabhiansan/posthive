import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, SESSION_EXPIRED_BODY, clearAuthCookies } from "./auth/authGuard.js";
import { withAuth as baseWithAuth } from "./auth/withAuth.js";
import { byIp } from "./ipRateLimit.js";

/**
 * The Canvas authentication gate. It BOUNDS THE AUTHENTICATION WORK (database reads, or remote calls under Supabase) that failed,
 * revoked or replayed credentials can cause on the Canvas routes. It does NOT prevent request floods, connection exhaustion, floods
 * from many source addresses, or the authentication cost of valid sessions, and it gives no per-client protection unless `req.ip`
 * is the visitor (that depends on the app's `trustProxy` setting, which this file never reads or changes).
 *
 * Why it exists: `withAuth` runs as a route preHandler, after the global limiter, and a route-level limiter cannot be stacked on
 * the global one (@fastify/rate-limit runs ONE limiter per request). So a request that auth refuses (401) was never counted by
 * any limiter. The gate decides by OUTCOME: successes cost nothing, failures are counted per credential, and only one request per
 * credential authenticates at a time (single-flight). It works in two places. `onRequest` (before the body is read) only
 * COUNTS and REFUSES: the anonymous budget, and a credential that is already blocked. It registers nothing. The single-flight
 * ADMISSION runs inside `canvasWithAuth`, right before authentication and after the body has been read, so a slow or trickling
 * body never holds a credential's flight, and a request that ends before authentication (a 400, 413, 415, a 501 from an earlier
 * preHandler) never takes one.
 *
 * What it reads: the two auth cookies (exactly what `withAuth` reads), `req.ip`, the guard's `authVia`, and the cookies the reply
 * issues. Never `Authorization`, `?token=`, `X-Forwarded-*` or any other header. No JWT is parsed or verified here. A credential
 * is represented by a handle: a keyed hash (HMAC with a random per-process key), so a raw cookie value is never a map key, a
 * counter, a log field or stored anywhere, and a restart changes every handle.
 *
 * Single-flight (admission): the first request for a credential set is its LEADER and authenticates; same-set requests park (at most
 * `waiters`, for at most `waitMs`, and they NEVER authenticate while parked or after a timeout: a timeout is a 503). When the
 * leader authenticates, the parked requests are released as a COHORT and authenticate in parallel; the flight keeps owning every
 * handle until the last one finishes, so no overlapping request can open a second flight meanwhile. The first failure seen in the
 * cohort closes it to newcomers (FAILING). A flight ends when authentication ends, not when the handler ends.
 *
 * Known limits: the numbers are provisional; the bound is asserted by call-count tests, not load tests;
 * more than `cohort` simultaneous requests on one credential get a 429 for the excess; counters are per process.
 *
 * PRODUCTION DEPLOYMENT BLOCKER (open, do not deploy the gate behind the production proxy until it is decided): see the failure
 * mode below. Closing it needs a proxy-aware `trustProxy` setting, which needs verified Caddy network details and its own approved
 * change; this file neither enables it nor works around it, and no Stage B change belongs in the Canvas gate.
 *
 * THE FAILURE MODE TO KNOW ABOUT, where `req.ip` is shared by every visitor (behind a proxy the app does not trust): the anonymous
 * and new-failing-handle budgets are then site-wide. A client that sends garbage credentials fast enough (about 5 a second) can make
 * every credential the server has not recently seen succeed (a new session, one idle for more than `goodTtlMs`, anyone after a
 * restart) get a 429 for up to a minute, and 61 cookie-less requests make cookie-less visitors get 429 instead of 401, which the web
 * client does not treat as "sign in again". This is the price of counting by address without trusting a forwarded one. It goes away
 * when `req.ip` is the visitor (a proxy-aware `trustProxy` setting, a deployment decision outside this file), EXCEPT: (1) addresses
 * that really are shared (an office, a campus, carrier-grade NAT) still share the budgets, so one neighbour sending about 150
 * two-cookie garbage requests a minute stops every not-recently-seen credential behind that address for up to a minute; (2) a
 * crowd of honest sessions that all idle-expire and come back within a minute does the same to the next logins (a failure of a
 * known-good credential also counts toward F); (3) IPv6: the budgets are keyed by the full address, so a client that owns a /64
 * has a fresh one for every request and only T (3 per credential) is left to bound it.
 *
 * PROVIDER FAULTS. A provider that THROWS on a fault is an ERROR: it counts toward neither T nor F, clears no known-good mark and
 * does not close a cohort. The request that hit it gets the app's 500; same-credential parked waiters get 503 + Retry-After; a
 * waiter that only shared one cookie re-enters admission.
 *
 * The LOCAL provider (the one production uses) throws on a fault. `validateAccessToken` answers null for a refused credential: a
 * token the JWT library rejects (anything `jwt.verify` throws, which includes a "typ: JWT" token whose payload is not JSON), a token of
 * the wrong type or without a session id, a session that is gone, expired or someone else's, or a person that is gone. A database
 * error from the session read, from its housekeeping writes or from the person read propagates. This applies to every route that
 * authenticates through the guard, and to `/jobs/stream`, which calls `validateAccessToken` directly: a database outage there is a 500.
 *
 * SUPABASE IS DIFFERENT AND UNVERIFIED. `supabaseAuth.validateAccessToken` turns any `getUser()` error into null and its code was NOT
 * changed. The installed library (auth-js 2.108.2, read and probed with a stubbed fetch) does tell the kinds apart: a network failure
 * and a 500-504 or 520-530 answer are `AuthRetryableFetchError`, a bad token or a 429 is an `AuthApiError`, a revoked session is an
 * `AuthSessionMissingError`, a non-OK answer outside those codes with a non-JSON body is `AuthUnknownError` and a 200 with a non-JSON body is an
 * `AuthRetryableFetchError`. But nothing here has been run against a live Supabase project and the provider has no tests in this
 * repository, so under `AUTH_PROVIDER=supabase` a Supabase outage or rate limit seen on an access-only request reads as a refused
 * credential (counted, cookies cleared by the guard). No fault tolerance is claimed for that provider.
 */

export interface GateParams {
  /** Requests with no auth cookie, per address per window. */
  anon: number;
  /** Failed attempts per credential handle per window (T). */
  failures: number;
  /** Credential handles whose first failure was recorded, per address per window (F). */
  newFailingHandles: number;
  /** Concurrent leaders whose credential was not known-good, per address (Lu). */
  unknownLeaders: number;
  /** Parked requests per flight (W) and in total. */
  waiters: number;
  parked: number;
  /** Cohort members authenticating at once per flight (Wc). */
  cohort: number;
  windowMs: number;
  waitMs: number;
  flightTtlMs: number;
  goodTtlMs: number;
  /** Entries per map. */
  cap: number;
}

const DEFAULT_GATE_PARAMS: GateParams = {
  anon: 60,
  failures: 3,
  newFailingHandles: 300,
  unknownLeaders: 64,
  waiters: 100,
  parked: 1000,
  cohort: 100,
  windowMs: 60_000,
  waitMs: 2_000,
  flightTtlMs: 10_000,
  goodTtlMs: 300_000,
  cap: 10_000,
};

export type Outcome = "OK" | "FAILED" | "ERROR" | "INCONCLUSIVE";
type Verdict = "join" | "full" | "copy" | "unavailable" | "retry";
type State = "LEADING" | "COHORT" | "FAILING" | "DONE";

interface Waiter {
  /** true: waits for the leader's outcome (same credential set); false: waits for the flight to end (partial overlap). */
  same: boolean;
  verdict?: Verdict;
  wake(): void;
}
interface Flight {
  key: string;
  handles: string[];
  ip: string;
  unknown: boolean;
  state: State;
  /** Leader until its authentication ends, then every cohort member that has not finished authenticating. */
  active: number;
  parked: Set<Waiter>;
  leaderReleased: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
interface Ctx {
  handles: string[];
  access?: string;
  refresh?: string;
  ip: string;
  role: "none" | "leader" | "member";
  flight?: Flight;
  recorded: boolean;
  /** The request authenticated: `onSend` then marks the cookie values the reply issued (they exist only by then). */
  ok: boolean;
}

/** A bounded map of expiring entries: expired ones are dropped on read, the oldest is evicted at the cap (eviction forgives). */
class Ttl<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(private cap: number, private now: () => number) {}
  get(k: string): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp <= this.now()) {
      this.m.delete(k);
      return undefined;
    }
    return e.v;
  }
  set(k: string, v: V, ttl: number): void {
    this.m.delete(k);
    if (this.m.size >= this.cap) {
      const oldest = this.m.keys().next();
      if (!oldest.done) this.m.delete(oldest.value);
    }
    this.m.set(k, { v, exp: this.now() + ttl });
  }
  delete(k: string): void {
    this.m.delete(k);
  }
  keys(): string[] {
    return [...this.m.keys()];
  }
}

type Counter = { n: number };

const RATE_BODY = (status: 429 | 503, message: string) => ({ statusCode: status, error: status === 429 ? "Too Many Requests" : "Service Unavailable", message });
const TOO_MANY = "Rate limit exceeded — slow down and try again shortly";
const BUSY = "Sign-in is busy — try again in a moment";

const entries = new WeakMap<FastifyRequest, { gate: CanvasAuthGate; ctx: Ctx }>();

export interface CanvasAuthGate {
  /** Before the body is read: counts anonymous requests and refuses an already-blocked credential. Registers nothing. */
  onRequest(req: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  onSend(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown>;
  /** Single-flight admission, called by `canvasWithAuth` right before authentication. Resolves true when it ANSWERED the request (429, 503, a free 401). */
  admit(req: FastifyRequest, reply: FastifyReply): Promise<boolean>;
  /** Records the outcome of this request's authentication (called inline by `canvasWithAuth`). */
  record(req: FastifyRequest, outcome: Outcome): void;
  /** The handle of a cookie value (tests, and nothing else, ask for this). */
  handleOf(type: "a" | "r", value: string): string;
  stats(): GateStats;
}
export interface GateStats {
  flights: number;
  parked: number;
  unknownLeaders: Record<string, number>;
  failures: Record<string, number>;
  newFailingHandles: Record<string, number>;
  good: string[];
  keys: string[];
}

export function createCanvasAuthGate(opts: { params?: Partial<GateParams>; now?: () => number; log?: { error(obj: unknown, msg?: string): void } } = {}): CanvasAuthGate {
  const p: GateParams = { ...DEFAULT_GATE_PARAMS, ...opts.params };
  const now = opts.now ?? Date.now;
  const secret = crypto.randomBytes(32); // never logged, never stored: a restart changes every handle

  const anon = new Ttl<Counter>(p.cap, now);
  const failures = new Ttl<Counter>(p.cap, now); // T: by handle
  const newFailing = new Ttl<Counter>(p.cap, now); // F: by address
  const good = new Ttl<true>(p.cap, now);
  const owner = new Map<string, Flight>(); // handle -> its live flight
  const unknownLeaders = new Map<string, number>(); // address -> leaders in flight whose credential was not known-good
  let parkedTotal = 0;

  const handleOf = (type: "a" | "r", value: string) => `${type}:${crypto.createHmac("sha256", secret).update(value).digest("hex").slice(0, 32)}`;
  const bump = (map: Ttl<Counter>, k: string): { n: number; created: boolean } => {
    let c = map.get(k);
    const created = !c;
    if (!c) {
      c = { n: 0 };
      map.set(k, c, p.windowMs);
    }
    c.n++;
    return { n: c.n, created };
  };

  const windowSeconds = Math.ceil(p.windowMs / 1000);
  const retryAfter = (reply: FastifyReply, seconds: number) => reply.header("retry-after", String(seconds));
  const tooMany = (reply: FastifyReply, seconds = 1) => retryAfter(reply, seconds).status(429).send(RATE_BODY(429, TOO_MANY));
  const unavailable = (reply: FastifyReply) => retryAfter(reply, 1).status(503).send(RATE_BODY(503, BUSY));
  // A free copy of what withAuth answers a failed credential: the same body, the same three cookies cleared.
  const copyOf401 = (reply: FastifyReply) => {
    clearAuthCookies(reply);
    return reply.status(401).send(SESSION_EXPIRED_BODY);
  };
  /** Waits for a reply to be written, then says so: an async hook that answers must not resolve before the response ends (else the chain carries on). */
  const answered = async (r: unknown): Promise<true> => {
    await r;
    return true;
  };
  const closed = (req: FastifyRequest, reply: FastifyReply) => req.raw.socket?.destroyed === true || reply.raw.destroyed === true;

  const releaseLeader = (f: Flight) => {
    if (f.leaderReleased) return;
    f.leaderReleased = true;
    if (!f.unknown) return;
    const left = (unknownLeaders.get(f.ip) ?? 1) - 1;
    if (left <= 0) unknownLeaders.delete(f.ip);
    else unknownLeaders.set(f.ip, left);
  };

  /** Ends a flight: its handles are free again and everyone still parked on it is woken. Idempotent. */
  const finish = (f: Flight) => {
    if (f.state === "DONE") return;
    f.state = "DONE";
    if (f.timer) clearTimeout(f.timer);
    for (const h of f.handles) if (owner.get(h) === f) owner.delete(h);
    releaseLeader(f);
    for (const w of f.parked) {
      if (!w.verdict) w.verdict = w.same ? "unavailable" : "retry";
      w.wake();
    }
  };

  const register = (handles: string[], key: string, ip: string, unknown: boolean): Flight => {
    const f: Flight = { key, handles, ip, unknown, state: "LEADING", active: 1, parked: new Set(), leaderReleased: false };
    for (const h of handles) owner.set(h, f);
    if (unknown) unknownLeaders.set(ip, (unknownLeaders.get(ip) ?? 0) + 1);
    f.timer = setTimeout(() => finish(f), p.flightTtlMs); // a stalled provider cannot hold a credential for ever
    f.timer.unref?.();
    return f;
  };

  const liveOwner = (handles: string[]): Flight | undefined => {
    for (const h of handles) {
      const f = owner.get(h); // `finish` removes a flight's entries in the same step that marks it DONE, so a live entry is a live flight
      if (f) return f;
    }
    return undefined;
  };

  const park = async (f: Flight, same: boolean, deadline: number): Promise<Verdict | "timeout"> => {
    const left = deadline - now();
    if (left <= 0) return "timeout";
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => (wake = resolve));
    const w: Waiter = { same, wake };
    f.parked.add(w);
    parkedTotal++;
    const timer = setTimeout(wake, left);
    timer.unref?.();
    try {
      await woken;
    } finally {
      clearTimeout(timer);
      f.parked.delete(w);
      parkedTotal--;
    }
    return w.verdict ?? "timeout";
  };

  /** The cookies the reply itself issued: values this server generated for an authenticated request. */
  const issued = (reply: FastifyReply): { access?: string; refresh?: string } => {
    const raw = reply.getHeader("set-cookie");
    const lines = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    const out: { access?: string; refresh?: string } = {};
    for (const line of lines) {
      const m = /^([^=]+)=([^;]*)/.exec(String(line));
      if (!m || !m[2]) continue; // a cleared cookie has an empty value
      let value = m[2];
      try {
        value = decodeURIComponent(value);
      } catch {
        /* keep the raw text */
      }
      if (m[1] === ACCESS_COOKIE_NAME) out.access = value;
      else if (m[1] === REFRESH_COOKIE_NAME) out.refresh = value;
    }
    return out;
  };

  // Known-good marks only credentials known to be valid: the one that actually authenticated (the guard says which, `authVia`) and
  // the values the server issued in the reply. A garbage value that merely rode along is never marked. No `authVia`: nothing is
  // marked (fail safe). The two halves happen at different times on purpose: the authenticating handle is known right after
  // `withAuth`; the issued cookie values only exist in `onSend` (@fastify/cookie writes Set-Cookie in its own onSend hook, which
  // runs before this scope's).
  // (A refresh token that was just rotated stays valid for the guard's 30 s grace window, so parallel siblings that still carry it are
  // genuine; its mark can outlive that window by up to goodTtlMs, which only exempts it from the F check: T and single-flight still bound it.)
  const markAuthenticated = (req: FastifyRequest, ctx: Ctx) => {
    const via = req.authVia;
    if (via === "access" && ctx.access) good.set(ctx.access, true, p.goodTtlMs);
    if (via === "refresh" && ctx.refresh) good.set(ctx.refresh, true, p.goodTtlMs);
    ctx.ok = !!via;
  };
  const markIssued = (reply: FastifyReply, ctx: Ctx) => {
    ctx.ok = false; // once
    const values = issued(reply);
    if (values.access) good.set(handleOf("a", values.access), true, p.goodTtlMs);
    if (values.refresh) good.set(handleOf("r", values.refresh), true, p.goodTtlMs);
  };

  const settleLeader = (f: Flight, outcome: Outcome) => {
    releaseLeader(f);
    f.active--;
    if (f.state === "DONE") return; // the TTL ended it first
    if (outcome === "OK") {
      f.state = "COHORT";
      // Reserve a place for every parked same-set request NOW (synchronously), so the flight cannot end between the leader's
      // success and the released requests starting to authenticate.
      for (const w of f.parked) {
        if (!w.same || w.verdict) continue;
        if (f.active < p.cohort) {
          f.active++;
          w.verdict = "join";
        } else w.verdict = "full";
        w.wake();
      }
      if (f.active <= 0) finish(f);
      return;
    }
    // A refused credential gives its waiters a free copy of the 401; anything else ("unavailable") is what `finish` hands out.
    if (outcome === "FAILED") for (const w of f.parked) if (w.same && !w.verdict) w.verdict = "copy";
    finish(f);
  };

  const settleMember = (f: Flight, outcome: Outcome) => {
    f.active--;
    if (f.state === "DONE") return;
    // Only a credential that FAILED closes the cohort (its newcomers then get a free 401). A provider ERROR says nothing about the
    // credential: closing on it would hand a valid person a 401 with their cookies cleared because the database blinked.
    if (outcome === "FAILED" && f.state === "COHORT") f.state = "FAILING";
    if (f.active <= 0) finish(f);
  };

  const recordOutcome = (req: FastifyRequest, outcome: Outcome) => {
    const e = entries.get(req);
    if (!e) return;
    const { ctx } = e;
    if (ctx.recorded || ctx.role === "none" || !ctx.flight) return;
    ctx.recorded = true;
    if (outcome === "OK") markAuthenticated(req, ctx);
    else if (outcome === "FAILED") {
      // Only a credential the provider REFUSED counts against it. A provider fault (ERROR: the database or the remote call threw)
      // is not the credential's fault, is not something a caller can choose, and must not lock a valid session out for a minute
      // after the fault is gone, so it clears no known-good mark and moves neither T nor F. (The work-bound in the plan is about
      // credential failures: a fault is bounded by single-flight and the unknown-leader cap, not by T.)
      for (const h of ctx.handles) {
        good.delete(h);
        // T counts attempts. F counts handles: it moves only when a recorded failure CREATES the handle's T entry.
        if (bump(failures, h).created) bump(newFailing, ctx.ip);
      }
    }
    if (ctx.role === "leader") settleLeader(ctx.flight, outcome);
    else settleMember(ctx.flight, outcome);
  };

  // Like admission, recording must never turn a valid request into a failure: a bug here is logged once, and the flight is ended so
  // nothing waits on it until the TTL.
  const record = (req: FastifyRequest, outcome: Outcome) => {
    try {
      recordOutcome(req, outcome);
    } catch (err) {
      failOpen(req, err);
      const f = entries.get(req)?.ctx.flight;
      if (f) finish(f);
    }
  };

  const isKnownGood = (ctx: Ctx) => ctx.handles.some((h) => good.get(h));
  // A credential that already failed `failures` times, or an unknown one while this address has used up its budget of new failing credentials.
  const blocked = (ctx: Ctx, knownGood: boolean) =>
    ctx.handles.some((h) => (failures.get(h)?.n ?? 0) >= p.failures) || (!knownGood && (newFailing.get(ctx.ip)?.n ?? 0) >= p.newFailingHandles);

  /** onRequest: counts and refuses, registers nothing (so a request refused here never has its body read). */
  const screen = (req: FastifyRequest, reply: FastifyReply): Promise<true> | undefined => {
    const access = req.cookies?.[ACCESS_COOKIE_NAME];
    const refresh = req.cookies?.[REFRESH_COOKIE_NAME];
    const ip = byIp(req);
    // Anonymous = neither auth cookie, whatever else the request carries (other cookies, headers, query values).
    if (!access && !refresh) {
      if (bump(anon, ip).n > p.anon) return answered(tooMany(reply, windowSeconds));
      return undefined; // withAuth answers 401 with no I/O
    }
    const ctx: Ctx = {
      handles: [],
      ip,
      role: "none",
      recorded: false,
      ok: false,
      ...(access ? { access: handleOf("a", access) } : {}),
      ...(refresh ? { refresh: handleOf("r", refresh) } : {}),
    };
    ctx.handles = [ctx.access, ctx.refresh].filter((h): h is string => !!h);
    entries.set(req, { gate, ctx });
    if (blocked(ctx, isKnownGood(ctx))) return answered(tooMany(reply, windowSeconds));
    return undefined;
  };

  /** Right before authentication (after the body is read): single-flight. True = the request was answered here and must not authenticate. */
  const admitRequest = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const ctx = entries.get(req)?.ctx;
    if (!ctx) return false;
    const key = [...ctx.handles].sort().join("|");
    const deadline = now() + p.waitMs; // one budget for every wait of this request

    // A partial-overlap request re-enters after each flight that ends; `failures` + 1 rounds are all it can need (T stops the rest).
    for (let round = 0; round <= p.failures; round++) {
      const knownGood = isKnownGood(ctx);
      // The body took time: re-check (a failure may have been recorded meanwhile). Known-good is exempt from the F part only.
      if (blocked(ctx, knownGood)) return answered(tooMany(reply, windowSeconds));

      const f = liveOwner(ctx.handles); // read and write of `owner` below have no `await` between them: registration is atomic
      if (!f) {
        if (!knownGood && (unknownLeaders.get(ctx.ip) ?? 0) >= p.unknownLeaders) return answered(tooMany(reply));
        ctx.flight = register(ctx.handles, key, ctx.ip, !knownGood);
        ctx.role = "leader";
        return false;
      }
      const same = f.key === key;
      if (f.state === "COHORT" && same) {
        if (f.active >= p.cohort) return answered(tooMany(reply));
        f.active++;
        ctx.flight = f;
        ctx.role = "member";
        return false;
      }
      if (f.state === "FAILING" && same) return answered(copyOf401(reply));
      if (f.parked.size >= p.waiters || parkedTotal >= p.parked) return answered(tooMany(reply));

      // A parked request does NO authentication. It waits for the leader's outcome (same set, leader still running) or for the
      // flight to end (overlap only), within the one deadline, and a timeout is a 503, never a fall-through to withAuth.
      const verdict = await park(f, same, deadline);
      switch (verdict) {
        case "join":
          if (closed(req, reply)) {
            settleMember(f, "INCONCLUSIVE"); // gave its reserved place back; it will not authenticate
            return answered(unavailable(reply));
          }
          ctx.flight = f;
          ctx.role = "member";
          return false;
        case "full":
          return answered(tooMany(reply));
        case "copy":
          return answered(copyOf401(reply));
        case "retry":
          continue;
        default:
          return answered(unavailable(reply));
      }
    }
    return answered(unavailable(reply));
  };

  const failOpen = (req: FastifyRequest, err: unknown) =>
    (opts.log ?? req.log).error({ err: err instanceof Error ? err.message : "gate error" }, "canvas auth gate failed open");

  const gate: CanvasAuthGate = {
    async onRequest(req, reply) {
      try {
        return await screen(req, reply);
      } catch (err) {
        // A bug in the gate must never lock people out: fail open and say so once, without any cookie data.
        failOpen(req, err);
        return undefined;
      }
    },
    async admit(req, reply) {
      try {
        return await admitRequest(req, reply);
      } catch (err) {
        failOpen(req, err);
        return false;
      }
    },
    async onSend(req, reply, payload) {
      // Only now does the reply's Set-Cookie exist: the cookie values it issued are valid credentials (known-good).
      try {
        const ctx = entries.get(req)?.ctx;
        if (ctx?.ok) markIssued(reply, ctx);
      } catch (err) {
        failOpen(req, err); // marking is an optimisation: the reply goes out either way
      }
      return payload;
    },
    record,
    handleOf,
    stats() {
      const counts = (m: Ttl<Counter>) => Object.fromEntries(m.keys().map((k) => [k, m.get(k)?.n ?? 0]));
      return {
        flights: new Set(owner.values()).size,
        parked: parkedTotal,
        unknownLeaders: Object.fromEntries(unknownLeaders),
        failures: counts(failures),
        newFailingHandles: counts(newFailing),
        good: good.keys(),
        keys: [...anon.keys(), ...failures.keys(), ...newFailing.keys(), ...good.keys(), ...owner.keys(), ...unknownLeaders.keys()],
      };
    },
  };
  return gate;
}

/** Registers the gate's hooks once, at the top of a plugin (all Canvas routes live in one). */
export function registerCanvasAuthGate(app: FastifyInstance, gate: CanvasAuthGate = createCanvasAuthGate()): CanvasAuthGate {
  app.addHook("onRequest", gate.onRequest);
  app.addHook("onSend", gate.onSend);
  return gate;
}

/**
 * `withAuth`, wrapped by the gate: admission right before it (after the body has been read), the outcome recorded right after it.
 * Inline in the handler chain on purpose: a client that disconnects does not cancel the chain (so authentication still runs), and
 * recording here cannot be skipped the way an `onResponse` hook can be. Without the gate's hooks registered (an app that disabled
 * it) and for an anonymous request this is exactly `withAuth`.
 */
export function makeCanvasWithAuth(base: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) {
  return async function canvasWithAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const e = entries.get(req);
    if (!e) return base(req, reply);
    if (await e.gate.admit(req, reply)) return; // answered (429, 503 or a free copy of the 401): it must not authenticate
    try {
      await base(req, reply);
    } catch (err) {
      e.gate.record(req, "ERROR");
      throw err;
    }
    e.gate.record(req, req.user ? "OK" : reply.statusCode === 401 ? "FAILED" : "INCONCLUSIVE");
  };
}

export const canvasWithAuth = makeCanvasWithAuth(baseWithAuth);
