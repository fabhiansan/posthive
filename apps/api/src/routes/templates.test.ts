// The Template Library routes: who sees a draft, that a new template starts as a draft, and who may publish. The
// routes run against a fake database that keeps the where of every query, so a test can prove the filter is asked for.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../lib/storage.js";

const h = vi.hoisted(() => ({
  role: "designer" as string | null,
  rows: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ fn: string; args: Record<string, any> }>,
  taken: false,
  // Changing what a template is made from runs in a transaction that first locks the template's row: the order is logged.
  inTx: false,
}));

const FORBIDDEN = { error: "Templates are managed by the design team only.", code: "FORBIDDEN" };

vi.mock("../lib/prisma.js", () => {
  const record = (fn: string, result: (args: Record<string, any>) => unknown) =>
    vi.fn(async (args: Record<string, any>) => {
      h.calls.push({ fn: h.inTx ? `tx:${fn}` : fn, args });
      return result(args);
    });
  const client = {
      template: {
        findMany: record("findMany", () => h.rows),
        findFirst: record("findFirst", (args) => (args.where.category && h.taken ? { id: "other" } : h.rows[0] ?? null)),
        create: record("create", (args) => ({ id: "t-new", published: false, user: { name: "Dewi Kusuma" }, createdAt: new Date("2026-11-12T03:00:00Z"), updatedAt: new Date("2026-11-12T03:00:00Z"), name: args.data.category, pillar: args.data.pillar, category: args.data.category, linkUrl: args.data.linkUrl, previewUrl: args.data.previewUrl, format: args.data.format, slides: args.data.slides, platforms: args.data.platforms })),
        update: record("update", () => h.rows[0]),
        updateMany: record("updateMany", (args) => ({ count: args.where.workspaceId === "ws-1" && h.rows.length ? 1 : 0 })),
        delete: record("delete", () => ({})),
      },
      upload: { count: vi.fn(async () => 0), updateMany: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({})) },
      legacyTemplateMedia: { findMany: vi.fn(async () => []) },
      // SELECT ... FOR UPDATE on one template: its id when it exists, nothing when it does not.
      $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        h.calls.push({ fn: "lock", args: { id: values[0], workspaceId: values[1] } });
        return h.rows.length > 0 && values[1] === "ws-1" ? [{ id: values[0] }] : [];
      }),
  };
  return {
    prisma: {
      ...client,
      $transaction: vi.fn(async (run: (tx: typeof client) => Promise<unknown>) => {
        h.calls.push({ fn: "tx:begin", args: {} });
        h.inTx = true;
        try {
          return await run(client);
        } finally {
          h.inTx = false;
          h.calls.push({ fn: "tx:end", args: {} });
        }
      }),
    },
  };
});
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async () => {},
  withAuthOrToken: async () => {},
  getUser: () => ({ id: "dewi" }),
  getWorkspaceId: () => "ws-1",
  getWorkspaceRole: async () => h.role,
  requireTemplateManagerRole: async () => (h.role === "designer" ? null : FORBIDDEN),
}));

import { templateRoutes } from "./templates.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(templateRoutes, { storage: {} as StorageAdapter });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  h.role = "designer";
  h.rows = [];
  h.calls = [];
  h.taken = false;
  h.inTx = false;
});

/** Calls by name, in or out of a transaction ("tx:" calls are counted with the plain ones, so existing checks keep meaning the same). */
const call = (fn: string) => h.calls.filter((c) => c.fn === fn || c.fn === `tx:${fn}`);
const order = () => h.calls.map((c) => c.fn);
const row = (patch: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "Case Study",
  pillar: "Promotional",
  category: "Case Study",
  linkUrl: "https://www.figma.com/design/AbC/Case",
  previewUrl: null,
  published: true,
  format: "carousel",
  slides: 5,
  platforms: ["linkedin", "instagram"],
  createdAt: new Date("2026-11-12T03:00:00Z"),
  updatedAt: new Date("2026-11-12T03:00:00Z"),
  user: { name: "Dewi Kusuma" },
  ...patch,
});
const body = (patch: Record<string, unknown> = {}) => ({
  pillar: "Promotional",
  category: "Case Study",
  linkUrl: "https://www.figma.com/design/AbC/Case",
  ...patch,
});

describe("template routes", () => {
  it("no longer has the .fig upload endpoint", async () => {
    expect(app.hasRoute({ method: "POST", url: "/templates/file" })).toBe(false);
    expect(app.hasRoute({ method: "POST", url: "/templates" })).toBe(true);
    expect((await app.inject({ method: "POST", url: "/templates/file" })).statusCode).toBe(404);
  });
});

describe("GET /templates: who sees a draft", () => {
  it("the design team asks for every template, drafts included", async () => {
    h.rows = [row({ published: false })];
    expect((await app.inject({ method: "GET", url: "/templates" })).statusCode).toBe(200);
    expect(call("findMany")[0].args.where).toEqual({ workspaceId: "ws-1", category: { not: null } });
  });

  it.each(["owner", "admin", "member", null])("a %s asks for the published ones only", async (role) => {
    h.role = role as string | null;
    await app.inject({ method: "GET", url: "/templates" });
    expect(call("findMany")[0].args.where).toMatchObject({ workspaceId: "ws-1", published: true });
  });

  it("a row carries the status, format, platforms and who made it; the user record does not leave", async () => {
    h.rows = [row()];
    const res = await app.inject({ method: "GET", url: "/templates" });
    const [t] = res.json().templates;
    expect(t).toMatchObject({ id: "t1", published: true, format: "carousel", slides: 5, platforms: ["linkedin", "instagram"], createdBy: "Dewi Kusuma" });
    expect(t).not.toHaveProperty("user");
  });
});

describe("POST /templates: a new template starts as a draft", () => {
  it("is created without `published`, so the column default (draft) applies, even when the body asks for it", async () => {
    const res = await app.inject({ method: "POST", url: "/templates", payload: body({ published: true }) });
    expect(res.statusCode).toBe(201);
    expect(call("create")[0].args.data).not.toHaveProperty("published");
    expect(res.json().template.published).toBe(false);
  });

  it("keeps the format, the slides of a carousel and the platforms", async () => {
    await app.inject({ method: "POST", url: "/templates", payload: body({ format: "carousel", slides: 5, platforms: ["instagram", "instagram", "linkedin"] }) });
    expect(call("create")[0].args.data).toMatchObject({ format: "carousel", slides: 5, platforms: ["instagram", "linkedin"] });
  });

  it("a member may not: 403, nothing is written", async () => {
    h.role = "member";
    const res = await app.inject({ method: "POST", url: "/templates", payload: body() });
    expect(res.statusCode).toBe(403);
    expect(call("create")).toHaveLength(0);
  });

  it("a second template for the same category is a 409", async () => {
    h.taken = true;
    expect((await app.inject({ method: "POST", url: "/templates", payload: body() })).statusCode).toBe(409);
  });
});

describe("PATCH /templates/:id: an edit does not change the status", () => {
  it("the edit data has no `published`, even when the body has it", async () => {
    h.rows = [row({ published: true })];
    const res = await app.inject({ method: "PATCH", url: "/templates/t1", payload: body({ published: false }) });
    expect(res.statusCode).toBe(200);
    expect(call("update")[0].args.data).not.toHaveProperty("published");
  });
});

describe("PATCH /templates/:id/status: publish and unpublish", () => {
  const set = (published: unknown, id = "t1") => app.inject({ method: "PATCH", url: `/templates/${id}/status`, payload: { published } });

  it("the design team publishes, and the where holds the workspace", async () => {
    h.rows = [row({ published: true })];
    const res = await set(true);
    expect(res.statusCode).toBe(200);
    expect(call("updateMany")[0].args).toEqual({ where: { id: "t1", workspaceId: "ws-1" }, data: { published: true } });
    expect(res.json().template).toMatchObject({ id: "t1", published: true });
  });

  it("and takes it back to a draft", async () => {
    h.rows = [row({ published: false })];
    await set(false);
    expect(call("updateMany")[0].args.data).toEqual({ published: false });
  });

  it.each(["owner", "admin", "member", null])("a %s may not: 403, nothing is written", async (role) => {
    h.role = role as string | null;
    const res = await set(true);
    expect(res.statusCode).toBe(403);
    expect(call("updateMany")).toHaveLength(0);
  });

  it("a template of another workspace (or none) is a 404", async () => {
    h.rows = [];
    expect((await set(true, "elsewhere")).statusCode).toBe(404);
  });

  it("a body that is not true or false is a 400", async () => {
    h.rows = [row()];
    expect((await set("yes")).statusCode).toBe(400);
    expect(call("updateMany")).toHaveLength(0);
  });
});

// ── Phase 4: what a template is made from (R1 to R3), and who sees one with a Canvas design ─────────────────────────

const FIGMA = "https://www.figma.com/design/AbC/Case";
/** A template row as the source check reads it: its design's latest revision comes nested, like Prisma's select. */
const made = (patch: Record<string, unknown> = {}, revision: number | null = null) =>
  row({ designId: revision === null && !("designId" in patch) ? null : "d1", design: revision === null ? (patch.designId ? { revisions: [] } : null) : { revisions: [{ number: revision }] }, ...patch });

describe("R1: PATCH /templates/:id/status publishing needs a source", () => {
  const publishIt = () => app.inject({ method: "PATCH", url: "/templates/t1/status", payload: { published: true } });
  const unpublishIt = () => app.inject({ method: "PATCH", url: "/templates/t1/status", payload: { published: false } });

  it("publishes a template with a valid Figma link", async () => {
    h.rows = [made({ published: false, linkUrl: FIGMA })];
    expect((await publishIt()).statusCode).toBe(200);
    expect(call("updateMany")[0].args).toEqual({ where: { id: "t1", workspaceId: "ws-1" }, data: { published: true } });
  });

  it("publishes a Canvas-native template (no link, a design with a revision), with no Figma URL anywhere", async () => {
    h.rows = [made({ published: false, linkUrl: null }, 2)];
    const res = await publishIt();
    expect(res.statusCode).toBe(200);
    expect(call("updateMany")[0].args.data).toEqual({ published: true });
    expect(JSON.stringify(h.calls)).not.toContain("figma.com");
  });

  it.each([
    ["no link and no design", { linkUrl: null }],
    ["a blank link", { linkUrl: "" }],
    ["a link of only spaces", { linkUrl: "   " }],
    ["a link that is not a Figma design", { linkUrl: "https://example.com" }],
    ["a look-alike host", { linkUrl: "https://figma.com.evil.com/design/x" }],
  ])("refuses %s: 409 TEMPLATE_INCOMPLETE, and nothing is written", async (_label, patch) => {
    h.rows = [made({ published: false, ...patch })];
    const res = await publishIt();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "TEMPLATE_INCOMPLETE" });
    expect(call("updateMany")).toHaveLength(0);
  });

  it("a design with no revision is not a source, and neither is a bad link next to it", async () => {
    h.rows = [made({ published: false, linkUrl: "https://example.com", designId: "d1" })];
    expect((await publishIt()).json()).toMatchObject({ code: "TEMPLATE_INCOMPLETE" });
    expect(call("updateMany")).toHaveLength(0);
  });

  it("locks the template first, then reads it, then writes: all inside the transaction", async () => {
    h.rows = [made({ published: false })];
    await publishIt();
    expect(order().slice(0, 4)).toEqual(["tx:begin", "lock", "tx:findFirst", "tx:updateMany"]);
    expect(call("lock")[0].args).toEqual({ id: "t1", workspaceId: "ws-1" });
  });

  it("a template that is not in this workspace is a 404 and nothing is read or written after the lock finds nothing", async () => {
    h.rows = [];
    expect((await publishIt()).statusCode).toBe(404);
    expect(order()).toEqual(["tx:begin", "lock", "tx:end"]);
  });

  it("taking it back to a draft is always allowed, touches only the status, and needs no lock", async () => {
    h.rows = [made({ published: true, linkUrl: null }, 1)];
    expect((await unpublishIt()).statusCode).toBe(200);
    expect(call("updateMany")[0].args).toEqual({ where: { id: "t1", workspaceId: "ws-1" }, data: { published: false } });
    expect(call("lock")).toHaveLength(0);
    expect(order()).not.toContain("tx:begin");
  });

  it("unpublishing a template with no source at all (a legacy row) is allowed too", async () => {
    h.rows = [made({ published: true, linkUrl: null })];
    expect((await unpublishIt()).statusCode).toBe(200);
  });
});

describe("R2: PATCH /templates/:id cannot remove the last source of a published template", () => {
  const edit = (patch: Record<string, unknown>) => app.inject({ method: "PATCH", url: "/templates/t1", payload: body(patch) });

  it("blanking the link of a published template whose only source it was: 409 SOURCE_REQUIRED, and nothing is written", async () => {
    h.rows = [made({ published: true, linkUrl: FIGMA })];
    const res = await edit({ linkUrl: "" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "SOURCE_REQUIRED" });
    expect(call("update")).toHaveLength(0);
  });

  it("a missing or null link is the same as a blank one", async () => {
    for (const linkUrl of [undefined, null, "   "]) {
      h.calls = [];
      h.rows = [made({ published: true, linkUrl: FIGMA })];
      const res = await app.inject({ method: "PATCH", url: "/templates/t1", payload: { pillar: "Promotional", category: "Case Study", ...(linkUrl === undefined ? {} : { linkUrl }) } });
      expect(res.statusCode, String(linkUrl)).toBe(409);
      expect(call("update")).toHaveLength(0);
    }
  });

  it("allowed when a Canvas revision is also a source: the link goes, the template stays published", async () => {
    h.rows = [made({ published: true, linkUrl: FIGMA }, 3)];
    const res = await edit({ linkUrl: "" });
    expect(res.statusCode).toBe(200);
    expect(call("update")[0].args.data.linkUrl).toBeNull();
    expect(call("update")[0].args.data).not.toHaveProperty("published");
  });

  it("changing to another valid Figma link is not removing a source: no lock, a plain update", async () => {
    h.rows = [made({ published: true, linkUrl: FIGMA })];
    const res = await edit({ linkUrl: "https://www.figma.com/design/Other/File" });
    expect(res.statusCode).toBe(200);
    expect(call("update")[0].args.data.linkUrl).toBe("https://www.figma.com/design/Other/File");
    expect(call("lock")).toHaveLength(0);
  });

  it("a DRAFT may lose its link: nothing is published that could be stranded", async () => {
    h.rows = [made({ published: false, linkUrl: FIGMA })];
    const res = await edit({ linkUrl: "" });
    expect(res.statusCode).toBe(200);
    expect(call("update")[0].args.data.linkUrl).toBeNull();
  });

  it("a link that is not a Figma design is still refused by the body schema, with no lock and no write", async () => {
    h.rows = [made({ published: true, linkUrl: FIGMA })];
    const res = await edit({ linkUrl: "https://example.com" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Figma link/);
    expect(call("lock")).toHaveLength(0);
    expect(call("update")).toHaveLength(0);
  });

  it("the edit that removes a link locks the template first, then reads it, then writes, inside one transaction", async () => {
    h.rows = [made({ published: false, linkUrl: FIGMA })];
    await edit({ linkUrl: "" });
    const inTx = order().slice(order().indexOf("tx:begin"));
    expect(inTx.slice(0, 4)).toEqual(["tx:begin", "lock", "tx:findFirst", "tx:update"]);
  });

  it("a template of another workspace (or none) is a 404, even when the edit removes a link", async () => {
    h.rows = [];
    expect((await edit({ linkUrl: "" })).statusCode).toBe(404);
  });
});

describe("R3: a published template that already has no source is left exactly as it is", () => {
  it("an unrelated edit succeeds: the format and platforms change, it stays published, and `published` is never in the write", async () => {
    h.rows = [made({ published: true, linkUrl: null })];
    const res = await app.inject({ method: "PATCH", url: "/templates/t1", payload: body({ linkUrl: "", format: "story", platforms: ["instagram"] }) });
    expect(res.statusCode).toBe(200);
    expect(call("update")[0].args.data).toMatchObject({ format: "story", platforms: ["instagram"], linkUrl: null });
    expect(call("update")[0].args.data).not.toHaveProperty("published");
  });

  // The body schema still refuses a non-Figma link that is sent, as it always did, so such a row is edited by dropping its link.
  it("the same for a published row whose stored link is not a Figma design (nothing it holds counted as a source): an edit that drops the link succeeds", async () => {
    h.rows = [made({ published: true, linkUrl: "https://example.com" })];
    const res = await app.inject({ method: "PATCH", url: "/templates/t1", payload: body({ linkUrl: "", format: "single" }) });
    expect(res.statusCode).toBe(200);
  });

  it("listing reads only: no write is issued, and the legacy row is returned to Marketing", async () => {
    h.role = "member";
    h.rows = [made({ published: true, linkUrl: null })];
    const res = await app.inject({ method: "GET", url: "/templates" });
    expect(res.statusCode).toBe(200);
    expect(res.json().templates.map((t: { id: string }) => t.id)).toEqual(["t1"]);
    for (const write of ["create", "update", "updateMany", "delete", "tx:begin", "lock"]) expect(order(), write).not.toContain(write);
  });

  it("it can be unpublished, but publishing it again needs a source (R1), and adding a valid Figma link makes it publishable", async () => {
    h.rows = [made({ published: false, linkUrl: null })];
    const again = await app.inject({ method: "PATCH", url: "/templates/t1/status", payload: { published: true } });
    expect(again.json()).toMatchObject({ code: "TEMPLATE_INCOMPLETE" });
    h.calls = [];
    h.rows = [made({ published: false, linkUrl: FIGMA })];
    expect((await app.inject({ method: "PATCH", url: "/templates/t1/status", payload: { published: true } })).statusCode).toBe(200);
  });

  it("the same for a legacy row whose link is not a Figma design", async () => {
    h.rows = [made({ published: false, linkUrl: "https://example.com" })];
    expect((await app.inject({ method: "PATCH", url: "/templates/t1/status", payload: { published: true } })).json()).toMatchObject({ code: "TEMPLATE_INCOMPLETE" });
  });
});

describe("a template can be created without a Figma link (a Canvas-native draft)", () => {
  it("a missing link creates an empty draft with linkUrl null", async () => {
    const res = await app.inject({ method: "POST", url: "/templates", payload: { pillar: "Promotional", category: "Case Study" } });
    expect(res.statusCode).toBe(201);
    expect(call("create")[0].args.data.linkUrl).toBeNull();
    expect(res.json().template.published).toBe(false);
  });

  it("a blank link is the same", async () => {
    const res = await app.inject({ method: "POST", url: "/templates", payload: body({ linkUrl: "   " }) });
    expect(res.statusCode).toBe(201);
    expect(call("create")[0].args.data.linkUrl).toBeNull();
  });

  it("a link that is given and is not a Figma design is still refused, and nothing is created", async () => {
    const res = await app.inject({ method: "POST", url: "/templates", payload: body({ linkUrl: "https://example.com" }) });
    expect(res.statusCode).toBe(400);
    expect(call("create")).toHaveLength(0);
  });

  it("a draft with no source cannot be published straight away", async () => {
    h.rows = [made({ published: false, linkUrl: null })];
    expect((await app.inject({ method: "PATCH", url: "/templates/t1/status", payload: { published: true } })).statusCode).toBe(409);
  });
});

describe("the library: a draft stays hidden, and a Canvas design shows only what it should", () => {
  it("a draft whose design has a revision is still not asked for by Marketing: the query holds published: true", async () => {
    for (const role of ["owner", "admin", "member", null]) {
      h.calls = [];
      h.role = role as string | null;
      h.rows = [made({ published: false, linkUrl: null }, 4)];
      await app.inject({ method: "GET", url: "/templates" });
      expect(call("findMany")[0].args.where, String(role)).toMatchObject({ workspaceId: "ws-1", published: true });
    }
  });

  it("the design team gets drafts too, and the library row carries the design id and the latest revision number", async () => {
    h.rows = [made({ published: false, linkUrl: null }, 4)];
    const [t] = (await app.inject({ method: "GET", url: "/templates" })).json().templates;
    expect(t).toMatchObject({ id: "t1", designId: "d1", canvasRevision: 4 });
    expect(t).not.toHaveProperty("design");
  });

  it("Marketing is told a template is made in Canvas (the revision number) but never which design it is", async () => {
    for (const role of ["owner", "admin", "member"]) {
      h.role = role;
      h.rows = [made({ published: true, linkUrl: null }, 4), made({ id: "t2", published: true, linkUrl: FIGMA, designId: "d2" }, 1), made({ id: "t3", published: true, linkUrl: FIGMA })];
      const { templates } = (await app.inject({ method: "GET", url: "/templates" })).json();
      expect(templates.map((t: { id: string }) => t.id), role).toEqual(["t1", "t2", "t3"]);
      expect(templates.map((t: { canvasRevision: number | null }) => t.canvasRevision), role).toEqual([4, 1, null]);
      for (const t of templates) {
        expect(t, role).not.toHaveProperty("designId");
        expect(t, role).not.toHaveProperty("design");
      }
      expect(JSON.stringify(templates), role).not.toMatch(/"d1"|"d2"|designId/);
    }
  });

  it("the design team keeps the design id, and every other field Marketing gets", async () => {
    h.rows = [made({ published: true, linkUrl: null }, 4)];
    const [t] = (await app.inject({ method: "GET", url: "/templates" })).json().templates;
    expect(t).toMatchObject({ designId: "d1", canvasRevision: 4, category: "Case Study", published: true });
    h.role = "member";
    const [m] = (await app.inject({ method: "GET", url: "/templates" })).json().templates;
    const { designId, ...same } = t;
    expect(designId).toBe("d1");
    expect(m).toEqual(same); // exactly the designer's row without the id
  });

  it("a row is still checked with its design id before it is stripped: a stranded one is dropped, not leaked", async () => {
    h.role = "member";
    h.rows = [made({ id: "stranded", published: true, linkUrl: null, designId: "d1" })];
    expect((await app.inject({ method: "GET", url: "/templates" })).json().templates).toEqual([]);
  });

  it("a template with no design reports a null design id and no revision", async () => {
    h.rows = [made({ linkUrl: FIGMA })];
    expect((await app.inject({ method: "GET", url: "/templates" })).json().templates[0]).toMatchObject({ designId: null, canvasRevision: null });
  });

  it("asks for the latest revision with a take of 1 (one indexed read), and puts the design in the library select only", async () => {
    await app.inject({ method: "GET", url: "/templates" });
    const { select } = call("findMany")[0].args;
    expect(select.design).toEqual({ select: { revisions: { orderBy: { number: "desc" }, take: 1, select: { number: true } } } });
    expect(select.designId).toBe(true);
  });

  describe("a row that points at a design but has nothing to show is not listed to Marketing (it cannot be made through the API)", () => {
    const ids = async (role: string) => {
      h.role = role;
      return (await app.inject({ method: "GET", url: "/templates" })).json().templates.map((t: { id: string }) => t.id);
    };

    it("design, no valid Figma link, no revision: dropped for Marketing, kept for the design team", async () => {
      h.rows = [made({ id: "stranded", published: true, linkUrl: null, designId: "d1" })];
      expect(await ids("member")).toEqual([]);
      expect(await ids("designer")).toEqual(["stranded"]);
    });

    it("design, a link that is not a Figma design, no revision: dropped for Marketing", async () => {
      h.rows = [made({ id: "x", published: true, linkUrl: "https://example.com", designId: "d1" })];
      expect(await ids("admin")).toEqual([]);
    });

    it("design with a revision and no link (Canvas-native): listed", async () => {
      h.rows = [made({ id: "native", published: true, linkUrl: null }, 1)];
      expect(await ids("member")).toEqual(["native"]);
    });

    it("design with no revision but a valid Figma link: listed", async () => {
      h.rows = [made({ id: "figma", published: true, linkUrl: FIGMA, designId: "d1" })];
      expect(await ids("member")).toEqual(["figma"]);
    });

    it("no design at all: never touched, whatever the link holds (legacy rows stay listed)", async () => {
      h.rows = [made({ id: "a", linkUrl: null }), made({ id: "b", linkUrl: "https://example.com" }), made({ id: "c", linkUrl: "" })];
      expect(await ids("member")).toEqual(["a", "b", "c"]);
    });
  });
});
