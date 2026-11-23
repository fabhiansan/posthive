// Pixelfed talks to an instance address that the person typed when connecting the account (it is stored, encrypted, with
// the token). Every call goes through safeFetch, so the connection is made to an address that was checked, a redirect is never followed
// for the POSTs that carry the token, and a private destination is refused. The success cases run against a REAL local HTTP server (the
// instance) by letting safeFetch accept loopback; the refusal cases use the real default policy.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma.js", () => ({ prisma: { account: { update: vi.fn() } } }));

// Only the address policy is relaxed, and only for the tests that talk to the local server; DNS is the real default resolver
// replaced by a fixed answer for the names used here. The real createSafeFetch (sockets, redirects, size caps) is what runs.
const policy = vi.hoisted(() => ({ allowLoopback: false, answers: {} as Record<string, string> }));
vi.mock("../lib/safeFetch.js", async () => {
  const real = await vi.importActual<typeof import("../lib/safeFetch.js")>("../lib/safeFetch.js");
  const ssrf = await vi.importActual<typeof import("../lib/ssrf.js")>("../lib/ssrf.js");
  const f = real.createSafeFetch({
    resolve: async (host) => [{ address: policy.answers[host] ?? "93.184.216.34", family: 4 }],
    isAllowedAddress: (ip) => (policy.allowLoopback && ip === "127.0.0.1") || !ssrf.isBlockedAddress(ip),
  });
  return { ...real, safeFetch: (url: string, o?: object) => f(url.replace(/^https:/, policy.allowLoopback ? "http:" : "https:"), { allowHttp: policy.allowLoopback, ...o }) };
});

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "0".repeat(64);
});

import { encrypt } from "../lib/encryption.js";
import { pixelfedAdapter, setStorageAdapter as setPixel } from "./pixelfed.js";

const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let server: http.Server;
let port = 0;
let behavior: "ok" | "redirect-private" | "redirect-same" | "big" = "ok";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("latin1") });
      if (behavior === "redirect-private") return void res.writeHead(307, { location: "http://169.254.169.254/latest/meta-data" }).end();
      if (behavior === "redirect-same") return void res.writeHead(307, { location: "/api/v1/statuses" }).end();
      if (behavior === "big") return void res.writeHead(200, { "content-type": "application/json", "content-length": String(20 * 1024 * 1024) }).end("x");
      const j = (o: object) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (req.url?.includes("/media")) return j({ id: "media-1" });
      if (req.method === "GET") return j({ favourites_count: 3, reblogs_count: 2, replies_count: 1 });
      return j({ id: "status-1" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
beforeEach(() => {
  seen.length = 0;
  behavior = "ok";
  policy.allowLoopback = true;
  policy.answers = { "social.example.test": "127.0.0.1" };
  const storage = { getBuffer: vi.fn(async () => Buffer.from([1, 2, 3])) } as never;
  setPixel(storage);
});

const account = (instanceUrl: string) => ({ id: "a1", platform: "x", credentials: encrypt(JSON.stringify({ accessToken: "tok-123", instanceUrl, accountId: "9" })) }) as never;
const here = () => account(`https://social.example.test:${port}`);

describe.each([
  ["pixelfed", pixelfedAdapter, "/api/v1/media"],
] as const)("%s: legitimate calls through safeFetch", (_name, adapter, mediaPath) => {
  it("publishes: uploads the picture as multipart with the token, then posts the status as JSON", async () => {
    const out = await adapter.createPost(here(), { text: "hello", mediaUrls: ["/uploads/a.png"], altTexts: ["a cat"] } as never);
    expect(out.platformPostId).toBe("status-1");
    const [media, status] = seen;
    expect(media.method).toBe("POST");
    expect(media.url).toBe(mediaPath);
    expect(media.headers.authorization).toBe("Bearer tok-123");
    expect(media.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(media.body).toContain('name="description"');
    expect(media.body).toContain("a cat");
    expect(status.url).toBe("/api/v1/statuses");
    expect(status.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(status.body)).toMatchObject({ status: "hello", visibility: "public", media_ids: ["media-1"] });
  });

  it("reads analytics (a GET with the token)", async () => {
    const out = await adapter.getAnalytics!(here(), "123");
    expect(out).toMatchObject({ likes: 3, reposts: 2, replies: 1 });
    expect(seen[0].url).toBe("/api/v1/statuses/123");
    expect(seen[0].headers.authorization).toBe("Bearer tok-123");
  });

  it("posts a reply to the post it made", async () => {
    const out = await adapter.createComment(here(), { postId: "p1", instanceUrl: "x" }, "thanks");
    expect(out.platformCommentId).toBe("status-1");
    expect(JSON.parse(seen[0].body)).toMatchObject({ status: "thanks", in_reply_to_id: "p1" });
  });

  it("an instance that answers with a redirect is NOT followed (the POST carries the token): the call fails and nothing else is contacted", async () => {
    behavior = "redirect-private";
    await expect(adapter.createComment(here(), { postId: "p1", instanceUrl: "x" }, "t")).rejects.toThrow(/redirect/i);
    expect(seen).toHaveLength(1); // only the instance; the metadata address was never contacted
    behavior = "redirect-same";
    seen.length = 0;
    await expect(adapter.createComment(here(), { postId: "p1", instanceUrl: "x" }, "t")).rejects.toThrow(/redirect/i);
    expect(seen).toHaveLength(1);
  });

  it("a response over the size cap is refused", async () => {
    behavior = "big";
    await expect(adapter.getAnalytics!(here(), "1")).rejects.toThrow(/too large/i);
  });
});

describe.each([
  ["pixelfed", pixelfedAdapter],
] as const)("%s: a stored instance address that is, or becomes, private is never contacted", (_name, adapter) => {
  const refuse = async (instanceUrl: string) => {
    policy.allowLoopback = false; // the real policy
    seen.length = 0;
    // the refusal itself, not just any failure: every message of a blocked destination says it is not allowed
    await expect(adapter.createComment(account(instanceUrl), { postId: "p", instanceUrl }, "t"), instanceUrl).rejects.toThrow(/not allowed/);
    await expect(adapter.getAnalytics!(account(instanceUrl), "1"), instanceUrl).rejects.toThrow(/not allowed/);
    expect(seen).toHaveLength(0); // not one request reached the local server, and no token was sent
  };

  it("loopback, private, link-local and metadata addresses, in every spelling", async () => {
    for (const u of [`https://127.0.0.1:${port}`, `https://[::1]:${port}`, `https://[::ffff:7f00:1]:${port}`, `https://2130706433:${port}`, "https://10.0.0.5", "https://192.168.1.1", "https://169.254.169.254", "https://100.64.0.1", "https://localhost", "https://db.internal"]) {
      await refuse(u);
    }
  });

  it("a public-looking NAME that resolves to a private address (what a hostname check cannot see)", async () => {
    policy.answers = { "evil.example.test": "127.0.0.1", "evil10.example.test": "10.1.2.3", "evil-meta.example.test": "169.254.169.254" };
    for (const host of Object.keys(policy.answers)) await refuse(`https://${host}:${port}`);
  });
});
