// Continue with Google / LinkedIn finds the account by the email the provider vouches for. For an account that has two-step
// verification on, that must NOT open a session: a mailbox (or an identity made with the same address) is the one thing the
// second step does not trust. It goes back to the login page with a message that says what to do. An account without two-step
// is signed in as before.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  // read when the module loads
  process.env.WEB_URL = "http://web.test";
  process.env.GOOGLE_CLIENT_ID = "g-id";
  process.env.GOOGLE_CLIENT_SECRET = "g-secret";
  process.env.GOOGLE_REDIRECT_URI = "http://api.test/auth/google/callback";
  process.env.LINKEDIN_CLIENT_ID = "li-id";
  process.env.LINKEDIN_CLIENT_SECRET = "li-secret";
  process.env.LINKEDIN_LOGIN_REDIRECT_URI = "http://api.test/auth/linkedin/login/callback";
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  // auth.ts reads the other providers' settings (and trims some) when it loads: any value will do, none is used here
  for (const key of [
    "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "INSTAGRAM_REDIRECT_URI", "LINKEDIN_REDIRECT_URI", "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET",
    "FACEBOOK_REDIRECT_URI", "MASTODON_CLIENT_ID", "MASTODON_CLIENT_SECRET", "MASTODON_REDIRECT_URI", "PIXELFED_REDIRECT_URI", "PINTEREST_CLIENT_ID",
    "PINTEREST_CLIENT_SECRET", "PINTEREST_REDIRECT_URI", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI",
  ]) process.env[key] ??= "unused";
  return {
    user: { id: "u1", totpEnabledAt: null as Date | null },
    isNew: false,
    tokensFor: [] as string[],
  };
});

vi.mock("../lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../lib/auth/oauthUser.js", () => ({ findOrCreateOAuthUser: async () => ({ user: h.user, isNew: h.isNew }) }));
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
  requireAdminRole: async () => null,
  setAuthCookies: (reply: any) => reply.header("x-test-session", "open"),
}));
vi.mock("../lib/enforcePlan.js", () => ({ enforcePlan: async () => null }));
vi.mock("../lib/avatarStore.js", () => ({ downloadAndStoreAvatar: async (u: string | null) => u }));

import { authRoutes } from "./auth.js";

let app: FastifyInstance;
const nonce = "n".repeat(64);
const state = Buffer.from(JSON.stringify({ returnTo: "/jobs", nonce })).toString("base64url");

/** The providers' answers: a verified email. */
function fakeProviders() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("oauth2.googleapis.com") || u.includes("accessToken")) return json({ access_token: "provider-token" });
      if (u.includes("googleapis.com/oauth2/v2/userinfo")) return json({ email: "victim@example.com", verified_email: true, name: "V", picture: "https://x/p.png" });
      if (u.includes("api.linkedin.com/v2/userinfo")) return json({ email: "victim@example.com", email_verified: true, name: "V", picture: "https://x/p.png" });
      return json({});
    }),
  );
}

beforeAll(async () => {
  app = Fastify();
  await app.register(cookie);
  await app.register(authRoutes);
  await app.ready();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});
beforeEach(() => {
  h.user = { id: "u1", totpEnabledAt: null };
  h.isNew = false;
  h.tokensFor = [];
  delete process.env.AUTH_PROVIDER;
  fakeProviders();
});

const google = () => app.inject({ method: "GET", url: `/auth/google/callback?code=c&state=${state}` });
const linkedin = () => app.inject({ method: "GET", url: `/auth/linkedin/login/callback?code=c&state=${state}`, headers: { cookie: `_lilogin=${nonce}` } });

describe.each([
  ["Google", google],
  ["LinkedIn", linkedin],
])("Continue with %s", (_name, callback) => {
  it("an account without two-step is signed in, as before", async () => {
    const res = await callback();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^http:\/\/web\.test\/auth\/callback\?returnTo=/);
    expect(res.headers["x-test-session"]).toBe("open");
    expect(h.tokensFor).toEqual(["u1"]);
  });

  it("an account WITH two-step opens no session: it goes back to the login page with the reason", async () => {
    h.user = { id: "u1", totpEnabledAt: new Date("2026-11-18T03:00:00Z") };
    const res = await callback();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("http://web.test/login?error=two_step_required");
    expect(res.headers["x-test-session"]).toBeUndefined();
    expect(h.tokensFor).toEqual([]); // no session was minted
  });
});
