// Only a published template reaches the people who make posts through the public API and MCP: a draft is neither listed
// nor usable, so asking for its id is "not found".
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../lib/storage.js";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, any> }>,
  found: null as null | Record<string, unknown>,
}));

const template = { id: "t1", name: "Case Study", pillar: "Promotional", category: "Case Study", linkUrl: "https://www.figma.com/design/AbC/Case", previewUrl: null, createdAt: new Date("2026-11-12T03:00:00Z"), updatedAt: new Date("2026-11-12T03:00:00Z") };

vi.mock("../lib/prisma.js", () => {
  const record = (fn: string, result: (args: Record<string, any>) => unknown) =>
    vi.fn(async (args: Record<string, any>) => {
      h.calls.push({ fn, args });
      return result(args);
    });
  return {
    prisma: {
      template: {
        findMany: record("findMany", () => [template]),
        findFirst: record("findFirst", () => h.found),
      },
      account: { findMany: vi.fn(async () => [{ id: "acc-1", platform: "instagram" }]) },
      postJob: { create: vi.fn(async () => ({ id: "new", status: "draft", scheduledFor: null, targets: [] })) },
    },
  };
});
vi.mock("../lib/queue.js", () => ({ schedulePostJob: vi.fn(), postJobQueue: {} }));
vi.mock("../lib/auth/withApiKey.js", () => ({
  withApiKey: async (req: { apiKeyUser?: unknown }) => {
    req.apiKeyUser = { id: "putri", workspaceId: "ws-1", role: "member", approvalRequired: true, plan: "pro", planStatus: "active" };
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
beforeEach(() => {
  h.calls = [];
  h.found = null;
});

const lastWhere = (fn: string) => h.calls.filter((c) => c.fn === fn).at(-1)!.args.where;
const ctx = { role: "member", approvalRequired: true };

describe("public API: drafts stay hidden", () => {
  it("GET /api/v1/templates lists the published ones only", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/templates" });
    expect(res.statusCode).toBe(200);
    expect(lastWhere("findMany")).toMatchObject({ workspaceId: "ws-1", published: true });
  });

  it("POST /api/v1/templates/:id/use looks only among the published ones; a draft id is a 404", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/templates/draft-id/use", payload: { accountIds: ["acc-1"] } });
    expect(res.statusCode).toBe(404);
    expect(lastWhere("findFirst")).toMatchObject({ id: "draft-id", workspaceId: "ws-1", published: true });
  });
});

describe("MCP: drafts stay hidden", () => {
  it("list_templates lists the published ones only", async () => {
    await handleTool("list_templates", {}, "putri", "ws-1", ctx);
    expect(lastWhere("findMany")).toMatchObject({ workspaceId: "ws-1", published: true });
  });

  it("create_from_template on a draft id is 'Template not found'", async () => {
    await expect(handleTool("create_from_template", { template_id: "draft-id", account_ids: ["acc-1"] }, "putri", "ws-1", ctx)).rejects.toThrow("Template not found");
    expect(lastWhere("findFirst")).toMatchObject({ id: "draft-id", workspaceId: "ws-1", published: true });
  });
});
