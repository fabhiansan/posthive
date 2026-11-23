// Every way of promoting a draft to a scheduled post stops while the design is with the designer, and when there is no account
// to post to: the web page's schedule (jobsDesignRequest.test.ts), the public REST API's approve and the MCP approve_draft.
// Duplicating a post through the API must not copy its Studio design link either.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../lib/storage.js";

const h = vi.hoisted(() => ({
  job: null as null | Record<string, unknown>,
  updates: [] as unknown[],
  created: [] as Array<{ data: Record<string, unknown> }>,
  queued: [] as unknown[],
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    postJob: {
      findUnique: vi.fn(async () => h.job),
      findFirst: vi.fn(async () => h.job),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.created.push(args);
        return { id: "new", status: "draft", scheduledFor: null, targets: [] };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.updates.push(args);
        return { id: "p1", status: "pending", scheduledFor: new Date("2030-01-01T00:00:00Z") };
      }),
    },
  },
}));
vi.mock("../lib/queue.js", () => ({
  schedulePostJob: vi.fn(async (...a: unknown[]) => { h.queued.push(a); }),
  postJobQueue: {},
}));
vi.mock("../lib/auth/withApiKey.js", () => ({
  withApiKey: async (req: { apiKeyUser?: unknown }) => {
    req.apiKeyUser = { id: "admin-1", workspaceId: "ws-1", role: "admin", approvalRequired: false, plan: "pro", planStatus: "active" };
  },
  canUseApi: () => true,
}));

import { publicApiRoutes } from "./publicApi.js";
import { handleTool } from "./mcp.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(publicApiRoutes, { storage: {} as StorageAdapter });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const CONTENT = { title: "T", text: "Caption", canvasInstanceId: "ckaaaaaaaaaaaaaaaaaaaaaaa", canvasTemplateId: "ckbbbbbbbbbbbbbbbbbbbbbbb" };
const draft = (patch: Record<string, unknown> = {}) => ({
  id: "p1", workspaceId: "ws-1", userId: "admin-1", status: "draft", approvalStatus: null, content: JSON.stringify(CONTENT), commentText: null,
  scheduledFor: new Date("2030-01-01T00:00:00Z"), designRequest: null, targets: [{ id: "t1", accountId: "acc-1" }], ...patch,
});

beforeEach(() => {
  h.job = null;
  h.updates = [];
  h.created = [];
  h.queued = [];
});

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const restApprove = () => app.inject({ method: "POST", url: "/api/v1/posts/p1/approve", payload: { scheduledFor: FUTURE } });
const mcpApprove = () => handleTool("approve_draft", { post_id: "p1", scheduled_time: FUTURE }, "admin-1", "ws-1", { role: "admin", approvalRequired: false });

describe("REST approve and MCP approve_draft", () => {
  it("schedule a plain draft that has an account", async () => {
    h.job = draft();
    expect((await restApprove()).statusCode).toBe(200);
    await expect(mcpApprove()).resolves.toBeTruthy();
    expect(h.updates).toHaveLength(2);
    expect(h.queued).toHaveLength(2);
  });

  it("refuse a draft whose design is with the designer: 409 IN_DESIGN over REST, the same words over MCP, nothing queued", async () => {
    h.job = draft({ designRequest: { status: "sent" } });
    const res = await restApprove();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "IN_DESIGN" });
    await expect(mcpApprove()).rejects.toThrow(/design request is with the designer/);
    expect(h.updates).toHaveLength(0);
    expect(h.queued).toHaveLength(0);
  });

  it("a saved brief that was not sent does not stop them", async () => {
    h.job = draft({ designRequest: { status: "draft" } });
    expect((await restApprove()).statusCode).toBe(200);
  });

  it("approving a draft already in review is not blocked by the request (the reviewer decides that)", async () => {
    h.job = draft({ approvalStatus: "pending", designRequest: { status: "sent" } });
    expect((await restApprove()).statusCode).toBe(200);
    await expect(mcpApprove()).resolves.toBeTruthy();
  });

  it("refuse a draft with no account: 422 NO_ACCOUNT, so nothing is 'published' to no one", async () => {
    h.job = draft({ targets: [] });
    const res = await restApprove();
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "NO_ACCOUNT" });
    await expect(mcpApprove()).rejects.toThrow(/at least one account/);
    expect(h.updates).toHaveLength(0);
    expect(h.queued).toHaveLength(0);
  });
});

describe("duplicating a post through the API", () => {
  it("does not copy its Studio design link: two posts would share one design, and editing it for one would change the other", async () => {
    h.job = draft();
    expect((await app.inject({ method: "POST", url: "/api/v1/posts/p1/duplicate" })).statusCode).toBe(201);
    await handleTool("duplicate_post", { post_id: "p1" }, "admin-1", "ws-1", { role: "admin", approvalRequired: false });
    expect(h.created).toHaveLength(2);
    for (const { data } of h.created) {
      expect(JSON.parse(data.content as string)).toEqual({ title: "T", text: "Caption" });
    }
  });
});
