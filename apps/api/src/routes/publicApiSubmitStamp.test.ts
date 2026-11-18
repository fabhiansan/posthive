// A post that a Marketing key makes through the public API in a workspace with approval goes straight to review. The
// design team's dashboard reads "who sent it, when, which round" from the post, so these two routes must stamp it the way
// the web app's own send does. A key that may schedule on its own (admin) sends nothing for review and gets no stamp.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../lib/storage.js";

const h = vi.hoisted(() => ({
  role: "member" as string,
  created: [] as Array<Record<string, any>>,
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    template: {
      findFirst: vi.fn(async () => ({ id: "t1", name: "Case Study", pillar: "Promotional", category: "Case Study", linkUrl: null, previewUrl: null })),
    },
    account: { findMany: vi.fn(async () => [{ id: "acc-1" }]) },
    postJob: {
      create: vi.fn(async (args: { data: Record<string, any> }) => {
        h.created.push(args.data);
        return { id: "new", status: args.data.status, scheduledFor: args.data.scheduledFor, targets: [] };
      }),
    },
  },
}));
vi.mock("../lib/queue.js", () => ({ schedulePostJob: vi.fn(async () => {}), postJobQueue: {} }));
vi.mock("../lib/auth/withApiKey.js", () => ({
  withApiKey: async (req: { apiKeyUser?: unknown }) => {
    req.apiKeyUser = { id: "putri", workspaceId: "ws-1", role: h.role, approvalRequired: true, plan: "pro", planStatus: "active" };
  },
  canUseApi: () => true,
}));

import { publicApiRoutes } from "./publicApi.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(publicApiRoutes, { storage: {} as StorageAdapter });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  h.role = "member";
  h.created = [];
});

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const post = () =>
  app.inject({ method: "POST", url: "/api/v1/posts", payload: { content: "A caption", accountIds: ["acc-1"], scheduledFor: FUTURE } });
const useTemplate = () =>
  app.inject({ method: "POST", url: "/api/v1/templates/t1/use", payload: { accountIds: ["acc-1"], contentOverride: "A caption", draft: false, scheduledFor: FUTURE } });

describe.each([
  ["POST /api/v1/posts", post],
  ["POST /api/v1/templates/:id/use", useTemplate],
])("%s: a Marketing key in an approval workspace", (_name, send) => {
  it("makes a draft in review, stamped with who sent it, when, and that it is the first send", async () => {
    const res = await send();
    expect(res.statusCode).toBe(201);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ status: "draft", approvalStatus: "pending", submittedById: "putri", submitCount: 1 });
    expect(h.created[0].submittedAt).toBeInstanceOf(Date);
  });

  it("an admin key schedules on its own: no review, so no stamp", async () => {
    h.role = "admin";
    const res = await send();
    expect(res.statusCode).toBe(201);
    expect(h.created[0]).toMatchObject({ status: "pending", approvalStatus: null });
    expect(h.created[0]).not.toHaveProperty("submittedAt");
    expect(h.created[0]).not.toHaveProperty("submitCount");
  });
});
