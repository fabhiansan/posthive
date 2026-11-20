// Two-step verification with an authenticator app: the profile page's Turn on / Manage, and the second step of a login.
// The rules (what a challenge allows, how a code is spent) are in lib/auth/twoStep.ts and the arithmetic in lib/totp.ts.
// Every query is scoped to the signed-in person; a login's second step has no session yet and is scoped by its challenge.
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authProvider } from "../lib/auth/index.js";
import { getUser, setAuthCookies, withAuth } from "../lib/auth/withAuth.js";
import { createLocalTokens } from "../lib/auth/localAuth.js";
import { guessLimit } from "../lib/ipRateLimit.js";
import { answerChallenge, beginSetup, finishSetup, newRecoveryCodes, turnOff, twoStepState, verifySecondFactor } from "../lib/auth/twoStep.js";

/** What an authenticator app calls the entry. Kept in step with BRAND.name in the web app. */
const ISSUER = process.env.TWO_STEP_ISSUER ?? "Posthive";

const code = z.string().trim().min(6, "Enter the code from your app.").max(32, "That code is too long.");
const enableBody = z.object({ password: z.string().min(1, "Enter your password."), code });
const confirmBody = z.object({ password: z.string().min(1, "Enter your password."), code });
const loginBody = z.object({ challenge: z.string().min(32).max(128), code });

const refuse = (code: string, error: string) => ({ error, code });
const WRONG = refuse("WRONG_CODE", "That code isn't right. Check your app and try again.");
const LOCKED = refuse("TOO_MANY_WRONG_CODES", "Too many wrong codes. Wait 15 minutes, then try again.");
/** Where a recovery code exists (every place except setup, which has none yet), it gets the person in while the 6 digits are locked. */
const LOCKED_RECOVERY = refuse("TOO_MANY_WRONG_CODES", "Too many wrong codes. Wait 15 minutes, or use a recovery code.");

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? "Invalid request";

export async function twoStepRoutes(app: FastifyInstance): Promise<void> {
  // Whether it is on, since when, and how many recovery codes are left. No secret and no code ever leaves here.
  app.get("/user/two-step", { preHandler: [withAuth], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    const state = await twoStepState(userId);
    return reply.send({
      enabled: state.enabled,
      enabledAt: state.enabledAt?.toISOString() ?? null,
      recoveryLeft: state.recoveryLeft,
      // an account that signs in with Google or LinkedIn has no password here: their provider's own verification applies
      available: Boolean(user?.passwordHash),
    });
  });

  // Step 1: a fresh secret. It does nothing until /enable proves the person can read a code from it AND knows the password
  // (a stolen session alone must not be able to put its own phone on somebody's account and lock the owner out).
  app.post("/user/two-step/start", { preHandler: [withAuth], config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, passwordHash: true } });
    if (!user?.passwordHash) return reply.status(400).send(refuse("NO_PASSWORD", "Your account signs in with Google or LinkedIn, which has its own verification."));
    const setup = await beginSetup(userId, user.email, ISSUER);
    if (!setup) return reply.status(409).send(refuse("ALREADY_ON", "Two-step verification is already on."));
    return reply.send(setup);
  });

  // Step 2: the first code. It switches it on, makes the recovery codes (shown here, once) and signs the other devices out.
  app.post("/user/two-step/enable", { preHandler: [withAuth], config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const body = enableBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send(refuse("INVALID", firstIssue(body.error)));
    const owner = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (!owner?.passwordHash || !(await bcrypt.compare(body.data.password, owner.passwordHash))) {
      return reply.status(400).send(refuse("WRONG_PASSWORD", "Your password isn't right."));
    }

    const done = await finishSetup(userId, body.data.code);
    if (done.result !== "ok") {
      if (done.result === "locked") return reply.status(429).send(LOCKED);
      if (done.result === "wrong") return reply.status(400).send(WRONG);
      if (done.result === "not-started") return reply.status(400).send(refuse("NOT_STARTED", "Start again: choose Turn on and scan the new code."));
      return reply.status(409).send(refuse("ALREADY_ON", "Two-step verification is already on."));
    }

    // Every other device signed in without a code: they sign in again, and are asked for one
    await authProvider.revokeOtherSessions?.(userId, req.sessionId);
    return reply.send({ ok: true, recoveryCodes: done.recoveryCodes });
  });

  /** Turning it off and making new recovery codes need the password AND a code: a stolen session is not enough. */
  async function confirmed(req: { body: unknown; sessionId?: string; headers: Record<string, unknown> }, userId: string) {
    const body = confirmBody.safeParse(req.body);
    if (!body.success) return { problem: refuse("INVALID", firstIssue(body.error)), status: 400 };
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true, totpEnabledAt: true } });
    if (!user?.passwordHash || !user.totpEnabledAt) return { problem: refuse("NOT_ON", "Two-step verification isn't on."), status: 400 };
    if (!(await bcrypt.compare(body.data.password, user.passwordHash))) return { problem: refuse("WRONG_PASSWORD", "Your password isn't right."), status: 400 };
    const check = await verifySecondFactor(userId, body.data.code, req.headers["user-agent"] as string | undefined);
    if (check === "locked") return { problem: LOCKED_RECOVERY, status: 429 };
    if (check !== "ok") return { problem: WRONG, status: 400 };
    return null;
  }

  app.post("/user/two-step/disable", { preHandler: [withAuth], config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const stop = await confirmed(req, userId);
    if (stop) return reply.status(stop.status).send(stop.problem);
    await turnOff(userId);
    return reply.send({ ok: true });
  });

  app.post("/user/two-step/recovery-codes", { preHandler: [withAuth], config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const stop = await confirmed(req, userId);
    if (stop) return reply.status(stop.status).send(stop.problem);
    return reply.send({ ok: true, recoveryCodes: await newRecoveryCodes(userId) });
  });

  // The second step of a login. No session exists yet: the challenge from POST /auth/login is the only thing that names the
  // person, and it is good for 5 tries (counted before the code is looked at) and one success.
  app.post("/auth/login/two-step", { config: guessLimit(20) }, async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send(refuse("INVALID", firstIssue(body.error)));

    const answer = await answerChallenge(body.data.challenge, body.data.code);
    if (answer.result !== "ok") {
      if (answer.result === "locked") return reply.status(429).send(LOCKED_RECOVERY);
      if (answer.result === "wrong") return reply.status(401).send(WRONG);
      return reply.status(401).send(refuse("CHALLENGE_EXPIRED", "That sign-in took too long. Enter your email and password again."));
    }

    const user = await prisma.user.findUnique({ where: { id: answer.userId }, select: { id: true, email: true, name: true, avatarUrl: true, timezone: true } });
    if (!user) return reply.status(401).send(refuse("CHALLENGE_EXPIRED", "That sign-in took too long. Enter your email and password again."));
    const { accessToken, refreshToken } = await createLocalTokens(user.id, answer.userAgent);
    setAuthCookies(reply, accessToken, refreshToken, { persistent: answer.remember });
    return reply.send({ user });
  });
}
