// The workspace webhook: an admin types the address, and after each published post the runner POSTs a small JSON event to it. It goes
// through safeFetch: the connection is made to an address that was checked, a redirect is never followed, a private destination is
// never contacted, and a failure never touches the job. Success cases run against a real local HTTP server (loopback allowed only in
// those tests); refusal cases use the real address policy.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const policy = vi.hoisted(() => ({ allowLoopback: true, answers: {} as Record<string, string>, webhookUrl: "" as string | null }));

vi.mock("../lib/prisma.js", () => {
  const ok = (v: unknown = {}) => vi.fn(async () => v);
  return {
    prisma: {
      postJob: { update: ok(), findUnique: ok(null), create: ok({ id: "n" }) },
      workspace: { findUnique: vi.fn(async () => ({ plan: "pro", planStatus: "active", webhookUrl: policy.webhookUrl })) },
      postJobTarget: { update: ok(), updateMany: ok(), findMany: ok([{ status: "post_done" }]) },
      libraryItem: { updateMany: ok(), count: ok(0) },
      user: { findUnique: ok(null) },
      upload: { deleteMany: ok() },
    },
  };
});
vi.mock("../adapters/index.js", () => ({
  getAdapter: () => ({ refreshTokenIfNeeded: async (a: unknown) => a, createPost: async () => ({ platformPostId: "p", replyContext: {} }), createComment: vi.fn() }),
}));
vi.mock("../lib/queue.js", () => ({ schedulePostJob: vi.fn() }));
vi.mock("../lib/mailer.js", () => ({ sendPostFailedEmail: vi.fn(async () => {}) }));
vi.mock("../lib/safeFetch.js", async () => {
  const real = await vi.importActual<typeof import("../lib/safeFetch.js")>("../lib/safeFetch.js");
  const ssrf = await vi.importActual<typeof import("../lib/ssrf.js")>("../lib/ssrf.js");
  const f = real.createSafeFetch({
    resolve: async (host) => [{ address: policy.answers[host] ?? "93.184.216.34", family: 4 }],
    isAllowedAddress: (ip) => (policy.allowLoopback && ip === "127.0.0.1") || !ssrf.isBlockedAddress(ip),
  });
  return { ...real, safeFetch: (url: string, o?: object) => f(url.replace(/^https:/, policy.allowLoopback ? "http:" : "https:"), { allowHttp: policy.allowLoopback, ...o }) };
});

import { runJob } from "./jobRunner.js";

const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let behavior: "ok" | "redirect-private" | "slow" = "ok";
let server: http.Server;
let port = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (behavior === "redirect-private") return void res.writeHead(307, { location: "http://169.254.169.254/latest/meta-data" }).end();
      if (behavior === "slow") return;
      res.writeHead(200).end("ok");
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
  policy.answers = { "hooks.example.test": "127.0.0.1" };
  policy.webhookUrl = `https://hooks.example.test:${port}/in`;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const job = () =>
  ({
    id: "job-1", status: "pending", dryRun: false, userId: "u1", workspaceId: "ws-1", scheduledFor: new Date("2026-11-10T02:00:00Z"), commentText: null,
    content: JSON.stringify({ text: "Hello world", mediaUrls: [] }),
    targets: [{ id: "t1", accountId: "a1", status: "pending", attempts: 0, replyContext: null, postJobId: "job-1", account: { platform: "instagram" } }],
  }) as never;
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms)); // the webhook is fire-and-forget

describe("workspace webhook", () => {
  it("delivers the post.published event as JSON to the address the admin set", async () => {
    await runJob(job());
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/in");
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen[0].body)).toMatchObject({ event: "post.published", postId: "job-1", platforms: ["instagram"], text: "Hello world" });
  });

  it("a dry run sends nothing, and a workspace with no webhook sends nothing", async () => {
    await runJob({ ...(job() as object), dryRun: true } as never);
    policy.webhookUrl = null;
    await runJob(job());
    await settle();
    expect(seen).toHaveLength(0);
  });

  it("a redirect is NOT followed (nothing else is contacted) and the job is not affected", async () => {
    behavior = "redirect-private";
    await expect(runJob(job())).resolves.toBeUndefined();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await settle();
    expect(seen).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("webhook delivery failed"), expect.stringMatching(/redirect/i)); // refused by safeFetch, not followed
  });

  it("a destination that is private is never contacted: literals, a stored address that became private, and a public NAME that resolves privately", async () => {
    policy.allowLoopback = false; // the real address policy
    for (const url of [`https://127.0.0.1:${port}/in`, `https://[::1]:${port}/in`, `https://[::ffff:7f00:1]:${port}/in`, "https://169.254.169.254/x", "https://10.0.0.5/x", "https://localhost/x"]) {
      policy.webhookUrl = url;
      await expect(runJob(job()), url).resolves.toBeUndefined();
    }
    policy.answers = { "evil.example.test": "127.0.0.1", "evil10.example.test": "10.2.3.4" };
    for (const host of Object.keys(policy.answers)) {
      policy.webhookUrl = `https://${host}:${port}/in`;
      await expect(runJob(job()), host).resolves.toBeUndefined();
    }
    await settle();
    expect(seen).toHaveLength(0);
    // the two public names reached safeFetch and were refused by its address check (a plain fetch would just fail DNS)
    expect(vi.mocked(console.warn).mock.calls.filter((c) => /not allowed/.test(String(c[1])))).toHaveLength(2);
  });

  it("an address that stops answering costs the job nothing", async () => {
    behavior = "slow";
    const t = Date.now();
    await runJob(job());
    expect(Date.now() - t).toBeLessThan(3000); // runJob does not wait for the webhook
  });
});
