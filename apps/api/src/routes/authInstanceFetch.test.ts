// Connecting a Pixelfed account: the callback gets the instance address back inside an UNSIGNED state value and exchanges the
// code with that instance. The exchange goes through safeFetch: a private or rebinding destination is refused (a redirect to
// the account page with an error, nothing contacted), a redirect is never followed, and a real instance still connects.
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.WEB_URL = "http://web.test";
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  for (const key of [
    "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "INSTAGRAM_REDIRECT_URI", "LINKEDIN_REDIRECT_URI", "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET",
    "FACEBOOK_REDIRECT_URI", "MASTODON_CLIENT_ID", "MASTODON_CLIENT_SECRET", "MASTODON_REDIRECT_URI", "PIXELFED_REDIRECT_URI", "PINTEREST_CLIENT_ID",
    "PINTEREST_CLIENT_SECRET", "PINTEREST_REDIRECT_URI", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI", "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_LOGIN_REDIRECT_URI",
  ]) process.env[key] ??= "unused";
  return {
    allowLoopback: true,
    answers: {} as Record<string, string>,
    upserts: [] as Array<Record<string, any>>,
    prismaStateGone: false,
  };
});

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    oAuthState: { findFirst: vi.fn(async () => (h.prismaStateGone ? null : { id: "s1", expiresAt: new Date(Date.now() + 60_000) })), delete: vi.fn(async () => ({})), create: vi.fn(async () => ({})) },
    user: { findUnique: vi.fn(async () => ({ activeWorkspaceId: null, workspaceMembers: [] })) },
    account: { findFirst: vi.fn(async () => null), upsert: vi.fn(async (a: Record<string, any>) => void h.upserts.push(a)) },
  },
}));
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async () => {},
  getUser: () => ({ id: "u1" }),
  getWorkspaceId: () => "ws",
  getUserWorkspaceId: async () => null,
  requireAdminRole: async () => null,
  setAuthCookies: () => {},
}));
vi.mock("../lib/enforcePlan.js", () => ({ enforcePlan: async () => null }));
vi.mock("../lib/avatarStore.js", () => ({ downloadAndStoreAvatar: async (u: string | null) => u }));
vi.mock("../lib/safeFetch.js", async () => {
  const real = await vi.importActual<typeof import("../lib/safeFetch.js")>("../lib/safeFetch.js");
  const ssrf = await vi.importActual<typeof import("../lib/ssrf.js")>("../lib/ssrf.js");
  const f = real.createSafeFetch({
    resolve: async (host) => [{ address: h.answers[host] ?? "93.184.216.34", family: 4 }],
    isAllowedAddress: (ip) => (h.allowLoopback && ip === "127.0.0.1") || !ssrf.isBlockedAddress(ip),
  });
  return { ...real, safeFetch: (url: string, o?: object) => f(url.replace(/^https:/, h.allowLoopback ? "http:" : "https:"), { allowHttp: h.allowLoopback, ...o }) };
});

vi.setConfig({ testTimeout: 30_000 }); // the first test builds the whole auth module; slow only under a loaded full run
import { authRoutes } from "./auth.js";

const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let behavior: "ok" | "redirect-private" | "token-fails" = "ok";
let server: http.Server;
let port = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (behavior === "redirect-private") return void res.writeHead(307, { location: "http://169.254.169.254/latest/meta-data" }).end();
      const j = (status: number, o: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (req.url === "/oauth/token") return behavior === "token-fails" ? j(400, { error: "bad" }) : j(200, { access_token: "inst-token" });
      if (req.url === "/api/v1/accounts/verify_credentials") return j(200, { id: "77", username: "alice", avatar: "https://x/a.png" });
      if (req.url === "/api/v1/apps") return j(200, { client_id: "cid", client_secret: "csecret" });
      return j(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(cookie);
  await app.register(authRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  seen.length = 0;
  h.upserts = [];
  h.prismaStateGone = false;
  behavior = "ok";
  h.allowLoopback = true;
  h.answers = { "social.example.test": "127.0.0.1" };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const where = (r: { headers: Record<string, unknown> }) => String(r.headers.location);

describe("Pixelfed registration (GET /auth/pixelfed)", () => {
  it("registers the app on a real instance and redirects the person to its authorize page", async () => {
    const res = await app.inject({ method: "GET", url: `/auth/pixelfed?instance=${encodeURIComponent(`https://social.example.test:${port}`)}` });
    expect(res.statusCode).toBe(302);
    expect(where(res)).toContain("/oauth/authorize");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/v1/apps" });
    expect(JSON.parse(seen[0].body)).toMatchObject({ client_name: "Posthive" });
  });

  it("a public NAME that resolves to a private address is refused (what the hostname check on the typed address cannot see)", async () => {
    h.allowLoopback = false;
    h.answers = { "evil.example.test": "127.0.0.1", "evil10.example.test": "10.9.9.9" };
    for (const host of Object.keys(h.answers)) {
      const res = await app.inject({ method: "GET", url: `/auth/pixelfed?instance=${encodeURIComponent(`https://${host}:${port}`)}` });
      expect(where(res), host).toBe("http://web.test/accounts?error=pixelfed_registration_failed");
    }
    expect(seen).toHaveLength(0);
  });

  it("an instance that redirects the registration is not followed", async () => {
    behavior = "redirect-private";
    const res = await app.inject({ method: "GET", url: `/auth/pixelfed?instance=${encodeURIComponent(`https://social.example.test:${port}`)}` });
    expect(where(res)).toBe("http://web.test/accounts?error=pixelfed_registration_failed");
    expect(seen).toHaveLength(1);
  });
});

describe("Pixelfed callback", () => {
  const register = async (instanceUrl: string) => {
    const res = await app.inject({ method: "GET", url: `/auth/pixelfed?instance=${encodeURIComponent(instanceUrl)}` });
    return new URL(where(res)).searchParams.get("state")!;
  };
  const callback = (state: string) => app.inject({ method: "GET", url: `/auth/pixelfed/callback?code=c&state=${state}` });
  const here = () => `https://social.example.test:${port}`;

  it("connects: the code is exchanged with the registered client over the checked connection, the profile is read and the account saved", async () => {
    const res = await callback(await register(here()));
    expect(where(res)).toBe("http://web.test/accounts?connected=pixelfed");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /api/v1/apps", "POST /oauth/token", "GET /api/v1/accounts/verify_credentials"]);
    expect(JSON.parse(seen[1].body)).toMatchObject({ client_id: "cid", client_secret: "csecret", code: "c" });
    expect(seen[2].headers.authorization).toBe("Bearer inst-token");
    expect(h.upserts).toHaveLength(1);
  });

  it("a state that names ANOTHER instance than the one the client was registered on never receives the secret", async () => {
    const state = await register(here());
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(state, "base64url").toString()), instanceUrl: "https://attacker.example.test" })).toString("base64url");
    seen.length = 0;
    expect(where(await callback(forged))).toBe("http://web.test/accounts?error=state_expired");
    expect(seen).toHaveLength(0);
    expect(h.upserts).toHaveLength(0);
  });

  it("a state cannot be replayed", async () => {
    const state = await register(here());
    expect(where(await callback(state))).toContain("connected=pixelfed");
    seen.length = 0;
    h.prismaStateGone = true;
    expect(where(await callback(state))).toBe("http://web.test/accounts?error=state_expired");
    expect(seen).toHaveLength(0);
  });

  it("an instance that answers the token call with an error, or redirects, goes back with token_exchange_failed", async () => {
    for (const b of ["token-fails", "redirect-private"] as const) {
      const state = await register(here());
      behavior = b;
      expect(where(await callback(state)), b).toBe("http://web.test/accounts?error=token_exchange_failed");
      behavior = "ok";
    }
    expect(h.upserts).toHaveLength(0);
  });
});
