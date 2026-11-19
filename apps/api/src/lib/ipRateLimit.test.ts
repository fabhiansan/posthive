// The real @fastify/rate-limit, set up the way src/index.ts sets it up (a global key that prefers the Authorization header or the
// access cookie), with a route that uses guessLimit. A client that sends a different made-up Authorization header on every
// request must still run into the limit: that header is the client's own claim, and it picked its own key before.
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guessLimit } from "./ipRateLimit.js";

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
