import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma.js";
import type { AuthProvider, AuthUser } from "./types.js";
import { createSessionService } from "./sessionService.js";
import { prismaSessionStore } from "./prismaSessionStore.js";
import { ACCESS_TTL_MS } from "./sessionPolicy.js";
import { cleanUserAgent } from "../deviceLabel.js";
import { WRONG_PASSWORD, recordLoginEvent } from "../loginHistory.js";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET!;

// Access JWT is short-lived and carries the server-side session id (`sid`).
// Refresh tokens are opaque, hashed in the DB and rotated on every use.
// Policy numbers live in sessionPolicy.ts.
export const sessions = createSessionService({ store: prismaSessionStore });

function signAccess(userId: string, sessionId: string): string {
  return jwt.sign({ sub: userId, sid: sessionId, type: "access" }, ACCESS_SECRET, {
    expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
  });
}

/** Every sign-in opens a session and leaves a line in the person's history, whichever way they came in. */
async function startSession(userId: string, userAgent?: string | null) {
  const created = await sessions.create(userId, cleanUserAgent(userAgent));
  await recordLoginEvent({ userId, userAgent });
  return created;
}

function toAuthUser(user: { id: string; email: string; name: string; avatarUrl: string | null; timezone: string }): AuthUser {
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, timezone: user.timezone };
}

export const localAuthProvider: AuthProvider = {
  async register(email, password, name, userAgent) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new Error("Email already in use");

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, name, passwordHash },
    });

    // Create personal workspace with 14-day trial (no card required)
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const workspace = await prisma.workspace.create({
      data: {
        name: `${name}'s Workspace`,
        plan: "trialing",
        planStatus: "trialing",
        trialEndsAt,
        allowTrial: false, // trial already started — prevent re-use
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { activeWorkspaceId: workspace.id } });

    const { sessionId, refreshToken } = await startSession(user.id, userAgent);
    return { user: toAuthUser(user), accessToken: signAccess(user.id, sessionId), refreshToken };
  },

  async login(email, password, userAgent) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) throw new Error("Invalid email or password");

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      // Only a wrong password on a real account is history: an email that is nobody's leaves nothing behind
      await recordLoginEvent({ userId: user.id, userAgent, failure: WRONG_PASSWORD });
      throw new Error("Invalid email or password");
    }

    // The right password is not the whole login when the account has two-step verification: no session until the code is
    // right (routes/twoStep.ts). Nothing is written to the sign-in history yet: that happens when a session opens.
    if (user.totpEnabledAt) return { twoStepRequired: true, userId: user.id };

    // Other devices keep their own sessions; expired ones are removed lazily on use.
    const { sessionId, refreshToken } = await startSession(user.id, userAgent);
    return { user: toAuthUser(user), accessToken: signAccess(user.id, sessionId), refreshToken };
  },

  async validateAccessToken(token) {
    // A missing signing secret is a CONFIGURATION error, not a bad token: verify would reject every token with a JsonWebTokenError,
    // the catch below would call that "no user", and everyone would get a 401 and cleared cookies. Thrown here, outside that catch, it
    // is a 500 that is logged and reported, and (for the Canvas auth gate) an ERROR that counts against nobody.
    if (!ACCESS_SECRET) throw new Error("JWT_ACCESS_SECRET is not set: the local auth provider cannot verify sessions");
    let payload: { sub: string; sid?: string; type: string };
    try {
      payload = jwt.verify(token, ACCESS_SECRET) as typeof payload;
    } catch {
      // Whatever verify throws is a REJECTED token, so "no user": malformed, wrong signature or algorithm, expired, not yet valid, or a
      // "typ: JWT" token whose payload is not JSON (jws parses it before any signature check and it escapes as a raw SyntaxError, so
      // anyone can send one). verify does no I/O and the secret was checked above, so what it throws is about the token:
      // "authentication could not run" is only the database work below, which is deliberately NOT caught.
      return null;
    }
    // Tokens without `sid` predate server-side sessions — reject so they die at deploy.
    if (payload.type !== "access" || !payload.sid) return null;

    // From here a failure is the database's (or a bug), never the credential's, and it PROPAGATES: a 500 from the app's error handler
    // (and for the Canvas auth gate an ERROR, which counts against nobody). It must not become "no user": the guard answers that with a
    // 401 and cleared cookies, which would sign people out during an outage.
    const session = await sessions.authenticate(payload.sid);
    if (!session || session.userId !== payload.sub) return null;

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return null;
    return { ...toAuthUser(user), sessionId: payload.sid };
  },

  async refreshTokens(refreshToken) {
    const res = await sessions.refresh(refreshToken);
    if (!res) return null;
    return { accessToken: signAccess(res.userId, res.sessionId), refreshToken: res.refreshToken };
  },

  async logout(refreshToken, sessionId) {
    if (sessionId) await sessions.revoke(sessionId);
    if (refreshToken) await sessions.revokeByToken(refreshToken);
  },

  async revokeOtherSessions(userId, keepSessionId) {
    await sessions.revokeAllForUser(userId, keepSessionId);
  },
};

export async function createLocalTokens(userId: string, userAgent?: string | null): Promise<{ accessToken: string; refreshToken: string }> {
  const { sessionId, refreshToken } = await startSession(userId, userAgent);
  return { accessToken: signAccess(userId, sessionId), refreshToken };
}
