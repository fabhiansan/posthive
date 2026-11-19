// The routes a stranger can call with nothing but guesses must run into their limit even when the client sends a different
// made-up Authorization header on every request. The real routes and the real @fastify/rate-limit, set up as src/index.ts
// sets it; the database and the auth provider are replaced, so every call is a plain failed guess.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: async () => null },
    passwordReset: { findUnique: async () => null },
    totpChallenge: { findUnique: async () => null },
  },
}));
vi.mock("../lib/auth/index.js", () => ({
  authProvider: {
    login: async () => {
      throw new Error("Invalid email or password");
    },
    register: async () => {
      throw new Error("Email already in use");
    },
  },
}));
vi.mock("../lib/auth/localAuth.js", () => ({ createLocalTokens: async () => ({ accessToken: "a", refreshToken: "r" }) }));
vi.mock("../lib/mailer.js", () => ({ sendPasswordResetEmail: async () => {}, sendVerificationEmail: async () => {} }));

import { userRoutes } from "./user.js";
import { twoStepRoutes } from "./twoStep.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(cookie);
  // the same global limiter as src/index.ts: it prefers the Authorization header or the access cookie, then the address
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
  await app.register(userRoutes);
  await app.register(twoStepRoutes);
  await app.ready();
});
afterAll(() => app.close());

const bodies: Record<string, object> = {
  "/auth/login": { email: "victim@example.com", password: "guess" },
  "/auth/register": { email: "victim@example.com", password: "Password123", name: "X" },
  "/auth/forgot-password": { email: "victim@example.com" },
  "/auth/reset-password": { token: "t".repeat(64), password: "Password123" },
  "/auth/login/two-step": { challenge: "c".repeat(64), code: "123456" },
};
// the limits declared on each route
const LIMITS: Array<[string, number]> = [["/auth/login", 10], ["/auth/register", 10], ["/auth/forgot-password", 5], ["/auth/reset-password", 10], ["/auth/login/two-step", 20]];

describe.each(LIMITS)("%s", (url, max) => {
  it(`stops a client that sends a new made-up Authorization header every time, after ${max} tries`, async () => {
    const codes: number[] = [];
    for (let i = 0; i < max + 3; i++) {
      const res = await app.inject({ method: "POST", url, payload: bodies[url], headers: { authorization: `Bearer ${url}-${i}`, cookie: `access_token=${url}-${i}` } });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, max).every((c) => c !== 429)).toBe(true);
    expect(codes.slice(max).every((c) => c === 429)).toBe(true);
  });
});
