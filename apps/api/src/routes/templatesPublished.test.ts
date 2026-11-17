// Only a published template reaches the people who make posts through the public API and MCP: a draft is neither listed
// nor usable, so asking for its id is "not found".
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../lib/storage.js";

type Row = { id: string; name: string; pillar: string | null; category: string | null; linkUrl: string | null; previewUrl: string | null; designId?: string | null; published: boolean; workspaceId: string; createdAt: Date; updatedAt: Date };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, any> }>,
  // Every template of the fake database. A query is answered from it by evaluating the where, the order, the take and the
  // select it was asked with, so a keyset boundary or a missing filter changes the answer instead of being ignored.
  store: [] as Array<Record<string, any>>,
}));

/** Evaluates the parts of a Prisma `where` that the template queries use. */
const matches = (row: Record<string, any>, where: Record<string, any>): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Array<Record<string, any>>).every((w) => matches(row, w));
    if (key === "OR") return (cond as Array<Record<string, any>>).some((w) => matches(row, w));
    const value = row[key];
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond !== null && typeof cond === "object") {
      if ("not" in cond) return value !== cond.not;
      if ("lt" in cond) return value instanceof Date ? value.getTime() < (cond.lt as Date).getTime() : value < cond.lt;
      throw new Error(`unsupported condition on ${key}`);
    }
    return value === cond;
  });
const byNewest = (a: Record<string, any>, b: Record<string, any>) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const project = (row: Record<string, any>, select: Record<string, boolean>) => Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));

vi.mock("../lib/prisma.js", () => {
  const record = (fn: string, result: (args: Record<string, any>) => unknown) =>
    vi.fn(async (args: Record<string, any>) => {
      h.calls.push({ fn, args });
      return result(args);
    });
  return {
    prisma: {
      template: {
        findMany: record("findMany", ({ where, orderBy, take, select }) => {
          expect(orderBy).toEqual([{ updatedAt: "desc" }, { id: "desc" }]); // the existing order, in every batch
          return h.store.filter((r) => matches(r, where)).sort(byNewest).slice(0, take).map((r) => project(r, select));
        }),
        findFirst: record("findFirst", ({ where, select }) => {
          const row = h.store.find((r) => matches(r, where));
          return row ? project(row, select) : null;
        }),
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
  h.store = [];
});

const lastWhere = (fn: string) => h.calls.filter((c) => c.fn === fn).at(-1)!.args.where;
const ctx = { role: "member", approvalRequired: true };

const FIGMA = "https://www.figma.com/design/AbC/Case";
let serial = 0;
/** A published template of ws-1. `at` orders it: a later number is a newer change. */
const tpl = (patch: Partial<Row> & { at?: number } = {}): Row => {
  const { at = ++serial, ...rest } = patch;
  const id = rest.id ?? `t${String(at).padStart(5, "0")}`;
  return { id, name: "Case Study", pillar: "Promotional", category: "Case Study", linkUrl: FIGMA, previewUrl: null, designId: null, published: true, workspaceId: "ws-1", createdAt: new Date(2026, 0, 1), updatedAt: new Date(2026, 0, 1, 0, 0, at), ...rest };
};
const OLD_KEYS = ["category", "createdAt", "id", "linkUrl", "name", "pillar", "previewUrl", "updatedAt"];

const listApi = async (limit?: number) => (await app.inject({ method: "GET", url: `/api/v1/templates${limit === undefined ? "" : `?limit=${limit}`}` })).json().templates as Array<{ id: string }>;
const listMcp = async () => JSON.parse((await handleTool("list_templates", {}, "putri", "ws-1", ctx)).content[0].text).templates as Array<{ id: string }>;
const useApi = (id: string) => app.inject({ method: "POST", url: `/api/v1/templates/${id}/use`, payload: { accountIds: ["acc-1"] } });
const useMcp = (id: string) => handleTool("create_from_template", { template_id: id, account_ids: ["acc-1"] }, "putri", "ws-1", ctx);

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

// ── Phase 4: the public API and MCP return Figma references only ───────────────────────────────────────────────────

describe("the contract of the public API and MCP is unchanged", () => {
  it("TEMPLATE_SELECT is exactly what it was, and the design id is only in the visibility check's own select", async () => {
    const { TEMPLATE_SELECT, EXTERNAL_SELECT, LIBRARY_SELECT } = await import("../lib/templates.js");
    expect(Object.keys(TEMPLATE_SELECT).sort()).toEqual(OLD_KEYS);
    expect(Object.keys(EXTERNAL_SELECT).sort()).toEqual([...OLD_KEYS, "designId"].sort());
    expect(LIBRARY_SELECT).toHaveProperty("designId"); // the design is for the internal library
    expect(TEMPLATE_SELECT).not.toHaveProperty("designId");
    expect(TEMPLATE_SELECT).not.toHaveProperty("design");
  });

  it("the base filter is the one it always was, in every batch, and the order is the existing one", async () => {
    h.store = [tpl(), tpl()];
    await listApi();
    await listMcp();
    for (const c of h.calls.filter((x) => x.fn === "findMany")) {
      expect(c.args.where).toMatchObject({ workspaceId: "ws-1", category: { not: null }, published: true });
      expect(c.args.orderBy).toEqual([{ updatedAt: "desc" }, { id: "desc" }]);
    }
  });

  it("the fields of a listed template are exactly the old ones: no design id, no design", async () => {
    h.store = [tpl({ id: "t-fig", designId: "d1" }), tpl({ id: "t-none", designId: null })];
    const api = (await app.inject({ method: "GET", url: "/api/v1/templates" })).json().templates;
    expect(api).toHaveLength(2);
    // The list endpoints spread the design reference (linkUrl, previewUrl) into each item: that is the shape they had before.
    for (const t of api) expect(Object.keys(t).sort()).toEqual(["category", "createdAt", "firstComment", "id", "linkUrl", "name", "pillar", "previewUrl", "text", "updatedAt"]);
    const mcp = await listMcp();
    for (const t of mcp) expect(Object.keys(t).sort()).toEqual(["category", "createdAt", "id", "linkUrl", "name", "pillar", "previewUrl", "updatedAt"]);
    expect(JSON.stringify([api, mcp])).not.toMatch(/designId|"design"|revision|manifest/);
  });

  it("a template with no design is listed and usable for every link value, as before", async () => {
    h.store = [tpl({ id: "legacy-null", linkUrl: null }), tpl({ id: "legacy-other", linkUrl: "https://example.com" }), tpl({ id: "legacy-empty", linkUrl: "" }), tpl({ id: "figma", linkUrl: FIGMA })];
    expect((await listApi()).map((t) => t.id).sort()).toEqual(["figma", "legacy-empty", "legacy-null", "legacy-other"]);
    expect((await listMcp()).map((t) => t.id).sort()).toEqual(["figma", "legacy-empty", "legacy-null", "legacy-other"]);
    for (const id of ["legacy-null", "legacy-other", "legacy-empty", "figma"]) {
      expect((await useApi(id)).statusCode, id).toBe(201);
      await expect(useMcp(id), id).resolves.toBeDefined();
    }
  });
});

describe("a template with a Canvas design is returned only through a real Figma link", () => {
  it("a design with a revision and the link https://example.com stays excluded, from the lists and from use", async () => {
    h.store = [tpl({ id: "tricky", linkUrl: "https://example.com", designId: "d1" })]; // a Canvas revision may exist: it does not change the answer
    expect(await listApi()).toEqual([]);
    expect(await listMcp()).toEqual([]);
    const res = await useApi("tricky");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Template not found" });
    await expect(useMcp("tricky")).rejects.toThrow("Template not found");
  });

  it.each([
    ["a null link (Canvas-native)", null],
    ["an empty link", ""],
    ["a link of only spaces", "   "],
    ["a non-Figma https link", "https://example.com"],
    ["a non-Figma link with a design-like path", "https://example.com/design/abc"],
    ["a look-alike host", "https://figma.com.evil.com/design/abc"],
    ["http instead of https", "http://www.figma.com/design/abc"],
    ["a Figma community page", "https://www.figma.com/community/file/1"],
  ])("a design and %s is excluded everywhere", async (_label, linkUrl) => {
    h.store = [tpl({ id: "x", linkUrl, designId: "d1" })];
    expect(await listApi()).toEqual([]);
    expect(await listMcp()).toEqual([]);
    expect((await useApi("x")).statusCode).toBe(404);
    await expect(useMcp("x")).rejects.toThrow("Template not found");
  });

  it("a design with a valid Figma link is returned with exactly the old fields", async () => {
    h.store = [tpl({ id: "both", linkUrl: "  https://www.figma.com/design/AbC/Case  ", designId: "d1" })];
    const [api] = (await app.inject({ method: "GET", url: "/api/v1/templates" })).json().templates;
    expect(api).toMatchObject({ id: "both", linkUrl: "  https://www.figma.com/design/AbC/Case  ", previewUrl: null }); // the stored link, as it always was returned
    const used = await useApi("both");
    expect(used.statusCode).toBe(201);
    expect(used.json().designReference).toEqual({ linkUrl: "  https://www.figma.com/design/AbC/Case  ", previewUrl: null });
    expect((await listMcp()).map((t) => t.id)).toEqual(["both"]);
  });

  it("a draft is never returned, with or without a design", async () => {
    h.store = [tpl({ id: "d-none", published: false }), tpl({ id: "d-design", published: false, designId: "d1" })];
    expect(await listApi()).toEqual([]);
    expect(await listMcp()).toEqual([]);
    expect((await useApi("d-design")).statusCode).toBe(404);
  });

  it("another workspace's template is never returned", async () => {
    h.store = [tpl({ id: "theirs", workspaceId: "ws-2" })];
    expect(await listApi()).toEqual([]);
    expect((await useApi("theirs")).statusCode).toBe(404);
  });
});

describe("the lists return the first N eligible templates, with no scan cap", () => {
  /** n published templates, newest first by `at`; `eligible(at)` says whether each can be returned. */
  const fill = (n: number, eligible: (at: number) => boolean) => {
    h.store = Array.from({ length: n }, (_, i) => {
      const at = n - i; // the first one made is the oldest
      return tpl({ at, id: `t${String(at).padStart(5, "0")}`, linkUrl: eligible(at) ? FIGMA : null, designId: eligible(at) ? null : "d1" });
    });
  };
  const batches = () => h.calls.filter((c) => c.fn === "findMany");
  const ids = (list: Array<{ id: string }>) => list.map((t) => t.id);

  it("250 templates where the 150 newest are excluded: limit 100 returns the first 100 eligible ones, found after the first batch", async () => {
    fill(250, (at) => at <= 100); // the 150 newest (at 101 to 250) are Canvas-only; the 100 oldest are eligible
    const out = await listApi(100);
    expect(out).toHaveLength(100);
    expect(ids(out)[0]).toBe("t00100"); // the newest eligible one
    expect(ids(out).at(-1)).toBe("t00001");
    expect(batches().length).toBeGreaterThan(1); // it had to read past the first batch
  });

  it("excluded rows never use up the limit: limit 5 with 300 excluded rows ahead still returns 5", async () => {
    h.store = [...Array.from({ length: 300 }, (_, i) => tpl({ at: 1000 - i, linkUrl: null, designId: "d1" })), ...Array.from({ length: 8 }, (_, i) => tpl({ at: 100 - i }))];
    const out = await listApi(5);
    expect(ids(out)).toEqual(["t00100", "t00099", "t00098", "t00097", "t00096"]);
    expect(batches().length).toBe(4); // 100 + 100 + 100 excluded, then the batch that holds the eligible ones
  });

  it("the MCP list has no limit and no cap: eligible templates beyond row 500 are all returned", async () => {
    fill(1200, (at) => at % 100 === 0 || at <= 5); // eligible ones are spread out, many far down the list
    const expected = Array.from({ length: 1200 }, (_, i) => 1200 - i).filter((at) => at % 100 === 0 || at <= 5).map((at) => `t${String(at).padStart(5, "0")}`);
    expect(ids(await listMcp())).toEqual(expected);
    expect(expected.length).toBeGreaterThan(12);
  });

  it("fewer eligible templates than the limit: all of them, no error, and the scan ends when the data does", async () => {
    fill(350, (at) => at % 50 === 0);
    const out = await listApi(100);
    expect(out).toHaveLength(7);
    expect(batches()).toHaveLength(4); // 100, 100, 100, then 50 rows (fewer than a batch: the end)
  });

  it("no templates at all, and no eligible ones, are an empty list", async () => {
    expect(await listApi()).toEqual([]);
    fill(40, () => false);
    expect(await listApi()).toEqual([]);
    expect(await listMcp()).toEqual([]);
  });

  it("with enough eligible rows in the first batch, exactly one query is made", async () => {
    fill(300, () => true);
    const out = await listApi(10);
    expect(out).toHaveLength(10);
    expect(batches()).toHaveLength(1);
    expect(batches()[0].args.take).toBe(100);
  });

  it("a batch that ends inside rows with the same updatedAt neither skips nor repeats a row (the tie is broken by id)", async () => {
    // 230 rows, all changed at the same instant: the boundary after row 100 and after row 200 falls inside the tie.
    h.store = Array.from({ length: 230 }, (_, i) => tpl({ id: `t${String(i).padStart(5, "0")}`, updatedAt: new Date(2026, 0, 1) }));
    const out = ids(await listMcp());
    expect(out).toHaveLength(230);
    expect(new Set(out).size).toBe(230);
    expect(out).toEqual([...out].sort().reverse()); // newest-first order: updatedAt equal, so id descending
  });

  it("every later batch asks for rows strictly after the last one it read: a keyset boundary built from values, not a cursor row", async () => {
    fill(250, () => false);
    await listApi();
    const [first, second, third] = batches();
    expect(first.args.where).toEqual({ workspaceId: "ws-1", category: { not: null }, published: true });
    const last = h.store.slice().sort(byNewest)[99]; // the 100th row of the first batch
    expect(second.args.where).toEqual({
      AND: [
        { workspaceId: "ws-1", category: { not: null }, published: true },
        { OR: [{ updatedAt: { lt: last.updatedAt } }, { updatedAt: last.updatedAt, id: { lt: last.id } }] },
      ],
    });
    expect(third.args.where.AND[1].OR[0].updatedAt.lt.getTime()).toBeLessThan(second.args.where.AND[1].OR[0].updatedAt.lt.getTime()); // it only moves forward
    expect(Object.keys(first.args)).not.toContain("cursor"); // Prisma's cursor returns nothing if the cursor row is deleted mid-scan
    expect(Object.keys(second.args)).not.toContain("cursor");
  });

  it("the row a boundary was taken from being deleted between batches does not end the scan early", async () => {
    fill(250, (at) => at <= 50);
    const real = h.store.slice();
    const prismaMock = (await import("../lib/prisma.js")).prisma as unknown as { template: { findMany: ReturnType<typeof vi.fn> } };
    const findMany = prismaMock.template.findMany.getMockImplementation()!;
    let calls = 0;
    prismaMock.template.findMany.mockImplementation(async (args: Record<string, any>) => {
      const result = await findMany(args);
      if (++calls === 1) h.store = real.filter((r) => r.id !== result.at(-1).id); // the last row of the first batch is deleted
      return result;
    });
    try {
      const out = ids(await listApi(100));
      expect(out).toHaveLength(50); // every eligible row is still found
    } finally {
      prismaMock.template.findMany.mockImplementation(findMany);
    }
  });

  it("the API list and the MCP list return the same ids in the same order for the same data", async () => {
    fill(420, (at) => at % 7 === 0);
    h.calls = [];
    const api = ids(await listApi(100));
    const mcp = ids(await listMcp());
    expect(api).toEqual(mcp.slice(0, 100));
    expect(mcp).toHaveLength(60);
    expect(api).toHaveLength(60); // 60 eligible rows in all, so the API's limit of 100 returns all of them too
    expect(api).toEqual(mcp);
  });

  describe("the REST limit: a whole number, or a 400 (never a silently empty list)", () => {
    const get = (query: string) => app.inject({ method: "GET", url: `/api/v1/templates${query}` });
    beforeEach(() => fill(300, () => true));

    it.each([
      ["missing", "", 100],
      ["1", "?limit=1", 1],
      ["3", "?limit=3", 3],
      ["100", "?limit=100", 100],
      ["over the maximum (101)", "?limit=101", 100],
      ["over the maximum (500)", "?limit=500", 100],
      ["a very large number", "?limit=99999999999999999999", 100],
      ["leading zeros", "?limit=007", 7],
      // Finite whole numbers that Number() reads and that worked before still do:
      ["an exponent", "?limit=1e2", 100],
      ["a plus sign", "?limit=%2B5", 5],
      ["spaces around a number", "?limit=%205%20", 5],
      ["hexadecimal", "?limit=0x10", 16],
      ["a large finite exponent", "?limit=1e300", 100],
    ])("%s is accepted, as before", async (_label, query, count) => {
      const res = await get(query);
      expect(res.statusCode).toBe(200);
      expect(res.json().templates).toHaveLength(count);
    });

    it("zero is accepted and asks for no rows: an empty list, and no query is made", async () => {
      const res = await get("?limit=0");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ templates: [] });
      expect(batches()).toHaveLength(0);
    });

    it.each([
      ["empty", "?limit="],
      ["spaces", "?limit=%20%20"],
      ["not a number", "?limit=abc"],
      ["a number with text", "?limit=5abc"],
      ["negative", "?limit=-3"],
      ["a decimal", "?limit=2.5"],
      ["a decimal with text", "?limit=1.5e1x"],
      ["a decimal exponent", "?limit=1.5e0"],
      ["a non-ASCII digit", "?limit=%EF%BC%95"],
      // Not finite: every one is a 400. (Infinity used to be read as a number and capped to 100: that is no longer accepted.)
      ["Infinity", "?limit=Infinity"],
      ["plus Infinity", "?limit=%2BInfinity"],
      ["minus Infinity", "?limit=-Infinity"],
      ["NaN", "?limit=NaN"],
      ["a number that overflows to Infinity", "?limit=1e309"],
      ["a negative number that overflows", "?limit=-1e309"],
      ["a very long run of digits that overflows", `?limit=${"9".repeat(400)}`],
    ])("%s is a 400 with a message, and nothing is queried", async (_label, query) => {
      const res = await get(query);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "limit must be a whole number from 0 to 100" });
      expect(batches()).toHaveLength(0);
    });

    // A value given more than once is ambiguous, so it is a 400 whatever the values are (Fastify's query parser hands
    // an array over for a repeated key; the route never picks one).
    it.each([
      ["two different numbers", "?limit=5&limit=10"],
      ["the same number twice", "?limit=5&limit=5"],
      ["the larger first", "?limit=10&limit=5"],
      ["a number and zero", "?limit=5&limit=0"],
      ["zero twice", "?limit=0&limit=0"],
      ["a number and an empty value", "?limit=5&limit="],
      ["an empty value and a number", "?limit=&limit=5"],
      ["three times", "?limit=1&limit=2&limit=3"],
      ["a valid value and a malformed one", "?limit=5&limit=abc"],
      ["repeated with other parameters between", "?limit=5&x=1&limit=10"],
    ])("a repeated limit (%s) is a 400, and nothing is queried", async (_label, query) => {
      const res = await get(query);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "limit must be a whole number from 0 to 100" });
      expect(batches()).toHaveLength(0);
    });

    it("another parameter given twice is not the limit's business, and a one-time limit beside it still works", async () => {
      const res = await get("?x=1&x=2&limit=7");
      expect(res.statusCode).toBe(200);
      expect(res.json().templates).toHaveLength(7);
    });

    it("what the parser really hands over for a repeated limit is an array, so the rule above is what is being exercised", async () => {
      const Fastify = (await import("fastify")).default;
      const probe = Fastify();
      probe.get("/q", async (req) => ({ limit: (req.query as { limit?: unknown }).limit }));
      await probe.ready();
      expect((await probe.inject({ method: "GET", url: "/q?limit=5&limit=10" })).json()).toEqual({ limit: ["5", "10"] });
      expect((await probe.inject({ method: "GET", url: "/q?limit=5" })).json()).toEqual({ limit: "5" });
      await probe.close();
    });

    it("the bracket form is a different key, not a repeated limit: it is ignored, like any unknown parameter", async () => {
      const res = await get("?limit[]=5");
      expect(res.statusCode).toBe(200);
      expect(res.json().templates).toHaveLength(100); // no `limit`: the default
    });

    it("the MCP list takes no limit and is not affected", async () => {
      expect(await listMcp()).toHaveLength(300);
    });
  });
});
