// The real @fastify/rate-limit, set up the way src/index.ts sets it up (a global key that prefers the Authorization header or the
// access cookie), with a route that uses guessLimit. A client that sends a different made-up Authorization header on every
// request must still run into the limit: that header is the client's own claim, and it picked its own key before.
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { TRUSTED_PROXIES, guessLimit } from "./ipRateLimit.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  // the same global limiter as src/index.ts
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const auth = req.headers["authorization"] ?? "";
      if (auth.startsWith("Bearer ")) return auth.slice(7);
      const match = (req.headers["cookie"] ?? "").match(/access_token=([^;]+)/);
      if (match) return match[1];
      return req.ip;
    },
  });
  app.post("/guess", { config: guessLimit(3) }, async () => ({ ok: true }));
  app.post("/old-style", { config: { rateLimit: { max: 3, timeWindow: "15 minutes" } } }, async () => ({ ok: true }));
  await app.ready();
});
afterAll(() => app.close());

const hit = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, headers }).then((r) => r.statusCode);

describe("guessLimit", () => {
  it("the same client is stopped after its tries", async () => {
    expect(await Promise.all([1, 2, 3].map(() => hit("/guess")))).toEqual([200, 200, 200]);
    expect(await hit("/guess")).toBe(429);
  });

  it("a different made-up Authorization header on every request does NOT give a fresh allowance", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push(await hit("/guess", { authorization: `Bearer made-up-${i}` }));
    expect(codes.every((c) => c === 429)).toBe(true); // this address already used its tries above
  });

  it("nor does a made-up access cookie", async () => {
    expect(await hit("/guess", { cookie: "access_token=anything-new" })).toBe(429);
  });

  // The proof that the test above is not passing by accident: the old way of declaring the same limit lets the rotation through.
  it("the old declaration (no keyGenerator) is bypassed by rotating the header, which is what this fixes", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push(await hit("/old-style", { authorization: `Bearer made-up-${i}` }));
    expect(codes.every((c) => c === 200)).toBe(true);
  });
});

// Behind Caddy (Docker, 172.x) every request arrives from the proxy's address. Without trustProxy `req.ip` was that address for every
// visitor, so all of them shared one allowance. With the proxy trusted, `req.ip` is the visitor; with the proxy NOT trusted when the
// request came straight from the internet, the header is the client's own claim and must be ignored.
describe("trusting the proxy in front of the API", () => {
  let proxied: FastifyInstance;
  beforeAll(async () => {
    proxied = Fastify({ trustProxy: TRUSTED_PROXIES });
    await proxied.register(rateLimit, { global: false });
    proxied.get("/ip", async (req) => ({ ip: req.ip }));
    proxied.post("/guess", { config: guessLimit(2) }, async () => ({ ok: true }));
    await proxied.ready();
  });
  afterAll(() => proxied.close());

  const ipOf = (remoteAddress: string, xff?: string) =>
    proxied.inject({ method: "GET", url: "/ip", remoteAddress, headers: xff ? { "x-forwarded-for": xff } : {} }).then((r) => r.json().ip as string);
  const guess = (remoteAddress: string, xff?: string) =>
    proxied.inject({ method: "POST", url: "/guess", remoteAddress, headers: xff ? { "x-forwarded-for": xff } : {} }).then((r) => r.statusCode);

  it("the visitor behind Caddy (a private address) is the one the limit sees, not Caddy", async () => {
    expect(await ipOf("172.18.0.5", "203.0.113.7")).toBe("203.0.113.7");
    expect(await ipOf("::ffff:172.18.0.5", "203.0.113.7")).toBe("203.0.113.7");
    expect(await ipOf("100.64.3.9", "203.0.113.7")).toBe("203.0.113.7"); // a platform proxy (Railway)
    expect(await ipOf("127.0.0.1", "203.0.113.7")).toBe("203.0.113.7");
  });

  it("a header that arrives from the internet is the client's own claim: the address it connected from is used", async () => {
    expect(await ipOf("198.51.100.1", "1.2.3.4")).toBe("198.51.100.1");
  });

  it("through the proxy, a visitor gets their own allowance: one visitor using theirs up does not stop another", async () => {
    expect(await guess("172.18.0.5", "203.0.113.50")).toBe(200);
    expect(await guess("172.18.0.5", "203.0.113.50")).toBe(200);
    expect(await guess("172.18.0.5", "203.0.113.50")).toBe(429);
    expect(await guess("172.18.0.5", "203.0.113.51")).toBe(200); // somebody else, same proxy
  });

  it("a visitor cannot write a fresh address into the header to get a fresh allowance", async () => {
    // the real client (203.0.113.60) is appended by the proxy at the end; whatever it put in front is not believed
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push(await guess("172.18.0.5", `10.9.9.${i}, 203.0.113.60`));
    expect(codes).toEqual([200, 200, 429, 429]);
  });

  it("index.ts really uses the list (a test of the list alone would pass if it were left out)", () => {
    const index = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/Fastify\(\{[\s\S]*trustProxy:\s*TRUSTED_PROXIES/);
  });
});
