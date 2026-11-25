// The MCP update_post tool follows the same rule as the app: a draft belongs to the workspace (a quarter plan is
// imported by one person and kept by the team), a scheduled post stays with the person who made it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  job: null as null | Record<string, unknown>,
  updates: [] as unknown[],
  created: [] as Array<{ data: Record<string, unknown> }>,
  missingCanvas: false,
}));

vi.mock("../lib/prisma.js", () => {
  const db = {
    account: { findMany: vi.fn(async () => [{ id: "acc-1" }]) },
    postJob: {
      findUnique: vi.fn(async () => h.job),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.created.push(args);
        return { id: "new", status: args.data.status, scheduledFor: null, targets: [] };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.updates.push(args);
        return { id: "p1", status: h.job?.status, scheduledFor: null };
      }),
    },
    upload: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    $queryRaw: vi.fn(async () => h.missingCanvas ? [] : [{ url: "/uploads/canvas-designs/s1/p.png", userId: "head-of-marketing", claimedAt: new Date() }]),
  };
  return { prisma: db };
});
vi.mock("../lib/queue.js", () => ({ schedulePostJob: vi.fn() }));
vi.mock("../lib/auth/withApiKey.js", () => ({ withApiKey: async () => {}, canUseApi: () => true }));

import { handleTool } from "./mcp.js";
import { schedulePostJob } from "../lib/queue.js";

const stored = (patch: Record<string, unknown> = {}) => ({
  id: "p1",
  workspaceId: "ws-1",
  userId: "head-of-marketing",
  status: "draft",
  approvalStatus: null,
  content: JSON.stringify({ title: "T", text: "Caption" }),
  scheduledFor: new Date("2026-03-07T01:00:00Z"),
  ...patch,
});

const update = (ctx: { role: string | null; approvalRequired: boolean }, userId = "colleague") =>
  handleTool("update_post", { post_id: "p1", content: "Edited caption" }, userId, "ws-1", ctx);

beforeEach(() => {
  h.job = null;
  h.updates = [];
  h.created = [];
  h.missingCanvas = false;
  vi.mocked(schedulePostJob).mockClear();
});

describe("update_post: a colleague edits the head of marketing's draft", () => {
  it("a member key under the approval flow: allowed on a draft", async () => {
    h.job = stored();
    await expect(update({ role: "member", approvalRequired: true })).resolves.toBeTruthy();
    expect(h.updates).toHaveLength(1);
  });

  it("a member without the approval flow: allowed on a draft", async () => {
    h.job = stored();
    await expect(update({ role: "member", approvalRequired: false })).resolves.toBeTruthy();
  });

  it("an edit to a colleague's draft in review pulls it back to a draft, so it is sent again", async () => {
    h.job = stored({ approvalStatus: "pending" });
    await update({ role: "member", approvalRequired: true });
    expect(h.updates[0]).toMatchObject({ data: { approvalStatus: null, reviewNote: null, reviewedByUserId: null, reviewedAt: null } });
  });

  it("an approved (scheduled) post stays frozen for a member key under the approval flow, even the uploader's own", async () => {
    h.job = stored({ status: "pending", approvalStatus: "approved" });
    await expect(update({ role: "member", approvalRequired: true })).rejects.toThrow(/frozen/);
    await expect(update({ role: "member", approvalRequired: true }, "head-of-marketing")).rejects.toThrow(/frozen/);
    expect(h.updates).toHaveLength(0);
  });

  it("a scheduled post of a colleague stays closed to a member without the approval flow; the uploader may edit it", async () => {
    h.job = stored({ status: "pending" });
    await expect(update({ role: "member", approvalRequired: false })).rejects.toThrow("You can only edit your own posts.");
    await expect(update({ role: "member", approvalRequired: false }, "head-of-marketing")).resolves.toBeTruthy();
  });

  it("the design team never edits, a draft in review included", async () => {
    h.job = stored({ approvalStatus: "pending" });
    await expect(update({ role: "designer", approvalRequired: true })).rejects.toThrow(/Admin and Marketing only/);
    expect(h.updates).toHaveLength(0);
  });

  it("a post of another workspace is not found", async () => {
    h.job = stored({ workspaceId: "ws-other" });
    await expect(update({ role: "member", approvalRequired: true })).rejects.toThrow("Post not found");
  });

  it("an admin edits any draft or scheduled post, as before", async () => {
    h.job = stored({ status: "pending" });
    await expect(update({ role: "admin", approvalRequired: true })).resolves.toBeTruthy();
  });

  it("a text-only edit locks the final Canvas picture and refuses if its Upload row disappeared", async () => {
    const url = "/uploads/canvas-designs/s1/p.png";
    h.job = stored({ content: JSON.stringify({ text: "Caption", mediaUrls: [url], canvasDesigns: [{ submissionId: "s1", mediaUrl: url, bytes: 1200 }] }) });
    await expect(handleTool("update_post", { post_id: "p1", content: "Edited" }, "admin", "ws-1", { role: "admin", approvalRequired: false })).resolves.toBeTruthy();
    expect(h.updates).toHaveLength(1);
    h.updates = [];
    h.missingCanvas = true;
    await expect(handleTool("update_post", { post_id: "p1", content: "Stale" }, "admin", "ws-1", { role: "admin", approvalRequired: false })).rejects.toThrow(/removed|uploaded/);
    expect(h.updates).toHaveLength(0);
  });
});

describe("approve_draft: an approved Canvas design must be compatible with every final target", () => {
  const future = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const withDesign = (platform: string) => stored({
    content: JSON.stringify({ text: "Caption", mediaUrls: ["/uploads/canvas-designs/s1/p.png"], canvasDesigns: [{ submissionId: "s1", mediaUrl: "/uploads/canvas-designs/s1/p.png", bytes: 1200 }] }),
    designRequest: null,
    targets: [{ id: "t1", account: { platform } }],
  });
  const approve = () => handleTool("approve_draft", { post_id: "p1", scheduled_time: future() }, "admin", "ws-1", { role: "admin", approvalRequired: false });

  it("refuses Instagram before updating or queueing the post", async () => {
    h.job = withDesign("instagram");
    await expect(approve()).rejects.toThrow(/Instagram.*JPEG/);
    expect(h.updates).toHaveLength(0);
    expect(schedulePostJob).not.toHaveBeenCalled();
  });

  it("allows a compatible target and queues it", async () => {
    h.job = withDesign("linkedin");
    await expect(approve()).resolves.toBeTruthy();
    expect(h.updates).toHaveLength(1);
    expect(schedulePostJob).toHaveBeenCalledWith("p1", expect.any(Date));
  });

  it("checks ownership before revealing whether another member's draft is incompatible", async () => {
    h.job = { ...withDesign("instagram"), userId: "someone-else" };
    await expect(handleTool("approve_draft", { post_id: "p1", scheduled_time: future() }, "colleague", "ws-1", { role: "member", approvalRequired: false }))
      .rejects.toThrow("You can only approve your own drafts.");
    expect(h.updates).toHaveLength(0);
    expect(schedulePostJob).not.toHaveBeenCalled();
  });
});

describe("create_post: a post that goes to review is its first send", () => {
  const create = (ctx: { role: string | null; approvalRequired: boolean }) =>
    handleTool("create_post", { content: "Caption", account_ids: ["acc-1"] }, "colleague", "ws-1", ctx);

  it("a member key under the approval flow: waits for review, as send number 1 by that member", async () => {
    await create({ role: "member", approvalRequired: true });
    expect(h.created[0].data).toMatchObject({ status: "draft", approvalStatus: "pending", submittedById: "colleague", submitCount: 1 });
    expect(h.created[0].data.submittedAt).toBeInstanceOf(Date);
  });

  it("an owner key is not under the flow, so nothing was sent for review and nothing is stamped", async () => {
    await create({ role: "owner", approvalRequired: true });
    expect(h.created[0].data).toMatchObject({ approvalStatus: null });
    expect(h.created[0].data).not.toHaveProperty("submittedAt");
  });

  it("create refuses a Canvas-design URL without validated metadata", async () => {
    await expect(handleTool("create_post", { content: "Caption", account_ids: ["acc-1"], media_urls: ["/uploads/canvas-designs/s1/p.png"] }, "colleague", "ws-1", { role: "member", approvalRequired: false }))
      .rejects.toThrow(/without its design details/);
    expect(h.created).toHaveLength(0);
  });
});
