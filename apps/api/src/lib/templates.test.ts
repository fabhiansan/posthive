// What counts as a template's source, and who may be shown a template. The same vectors are in
// apps/web/src/lib/templates.test.ts: the two copies of these helpers must agree on every one of them.
import { beforeEach, describe, expect, it, vi } from "vitest";
// A test is the one place the API may reach into apps/web (as the canvas tests reach into apps/canvas): the page's own copy of the helpers.
import * as web from "../../../web/src/lib/templates";
import { hasCanvasSource, hasFigmaSource, hasUsableSource, isExternallyVisible, isLibraryVisible, slideColumns, slideImagesOf, sourceOf, toLibraryTemplate, withoutTemplateMedia } from "./templates.js";

// A database that holds a few template rows and legacy files and APPLIES the where of withoutTemplateMedia (`in`, `hasSome`, OR),
// so a test can tell a file that is protected from one that is not.
const db = vi.hoisted(() => ({
  templates: [] as Array<{ previewUrl: string | null; slideUrls: string[] }>,
  legacy: [] as string[],
}));
vi.mock("./prisma.js", () => ({
  prisma: {
    template: {
      findMany: vi.fn(async ({ where }: { where: { OR: Array<{ previewUrl?: { in: string[] }; slideUrls?: { hasSome: string[] } }> } }) =>
        db.templates.filter((t) => where.OR.some((c) => (c.previewUrl ? t.previewUrl !== null && c.previewUrl.in.includes(t.previewUrl) : t.slideUrls.some((u) => c.slideUrls!.hasSome.includes(u))))),
      ),
    },
    legacyTemplateMedia: { findMany: vi.fn(async ({ where }: { where: { url: { in: string[] } } }) => db.legacy.filter((u) => where.url.in.includes(u)).map((url) => ({ url }))) },
  },
}));

// [value, is it a Figma source?]
const LINK_VECTORS: Array<[unknown, boolean]> = [
  ["https://www.figma.com/design/AbC123/Case", true],
  ["https://figma.com/design/AbC123/Case", true],
  ["https://www.figma.com/file/AbC123/Case", true],
  ["https://www.figma.com/proto/AbC123/Case", true],
  ["https://www.figma.com/board/AbC123/Case", true],
  ["https://team.figma.com/design/AbC123/Case", true],
  ["  https://www.figma.com/design/AbC123/Case  ", true],
  ["HTTPS://WWW.FIGMA.COM/design/AbC123/Case", true],
  ["http://www.figma.com/design/AbC123/Case", false],
  ["https://example.com", false],
  ["https://example.com/design/abc", false],
  ["https://figma.com.evil.com/design/abc", false],
  ["https://evilfigma.com/design/abc", false],
  ["https://www.figma.com/community/file/1", false],
  ["https://www.figma.com/", false],
  ["figma.com/design/abc", false],
  ["javascript:alert(1)", false],
  ["", false],
  ["   ", false],
  ["\n\t", false],
  [null, false],
  [undefined, false],
  [0, false],
  [5, false],
  [{}, false],
  [[], false],
  [true, false],
];

describe("hasFigmaSource", () => {
  it.each(LINK_VECTORS)("%j → %s", (value, expected) => {
    expect(hasFigmaSource(value)).toBe(expected);
  });
});

describe("the page's copy of the helpers (apps/web/src/lib/templates.ts) agrees with this one", () => {
  it.each(LINK_VECTORS)("hasFigmaSource %j", (value) => {
    expect(web.hasFigmaSource(value)).toBe(hasFigmaSource(value));
  });

  it("hasUsableSource and isIncomplete agree on every link with and without a Canvas revision", () => {
    for (const [linkUrl] of LINK_VECTORS) {
      for (const canvasRevision of [null, 1]) {
        const t = { linkUrl: linkUrl as string | null, canvasRevision };
        expect(web.hasUsableSource(t), JSON.stringify(t)).toBe(hasUsableSource(t));
        expect(web.isIncomplete(t), JSON.stringify(t)).toBe(!hasUsableSource(t));
      }
    }
  });

  it("hasCanvasSource agrees", () => {
    for (const n of [null, undefined, 0, 1, 7]) expect(web.hasCanvasSource(n)).toBe(hasCanvasSource(n));
  });
});

describe("hasCanvasSource and hasUsableSource", () => {
  it("a Canvas source is a revision number, and nothing else", () => {
    expect(hasCanvasSource(1)).toBe(true);
    expect(hasCanvasSource(12)).toBe(true);
    expect(hasCanvasSource(null)).toBe(false);
    expect(hasCanvasSource(undefined)).toBe(false);
  });

  it.each([
    ["a Figma link", { linkUrl: "https://www.figma.com/design/A/B", canvasRevision: null }, true],
    ["a Canvas revision", { linkUrl: null, canvasRevision: 1 }, true],
    ["both", { linkUrl: "https://www.figma.com/design/A/B", canvasRevision: 2 }, true],
    ["neither", { linkUrl: null, canvasRevision: null }, false],
    ["a blank link and no revision", { linkUrl: "  ", canvasRevision: null }, false],
    ["a non-Figma link and no revision", { linkUrl: "https://example.com", canvasRevision: null }, false],
    ["a non-Figma link and a revision", { linkUrl: "https://example.com", canvasRevision: 3 }, true],
    ["nothing given", {}, false],
  ])("%s → %s", (_label, t, expected) => {
    expect(hasUsableSource(t)).toBe(expected);
  });

  it("reads a template row with its design's latest revision nested, like the select returns it", () => {
    expect(sourceOf({ linkUrl: null, design: { revisions: [{ number: 4 }] } })).toEqual({ linkUrl: null, canvasRevision: 4 });
    expect(sourceOf({ linkUrl: "x", design: { revisions: [] } })).toEqual({ linkUrl: "x", canvasRevision: null });
    expect(sourceOf({ linkUrl: "x", design: null })).toEqual({ linkUrl: "x", canvasRevision: null });
    expect(sourceOf({ linkUrl: "x" })).toEqual({ linkUrl: "x", canvasRevision: null });
  });
});

describe("isExternallyVisible (the public API and MCP)", () => {
  it("a template with no design is visible whatever its link holds (legacy rows included)", () => {
    for (const [linkUrl] of LINK_VECTORS) expect(isExternallyVisible({ designId: null, linkUrl: linkUrl as string | null })).toBe(true);
    expect(isExternallyVisible({ linkUrl: null })).toBe(true);
  });

  it("a template with a design is visible only through a real Figma link", () => {
    for (const [linkUrl, isFigma] of LINK_VECTORS) expect(isExternallyVisible({ designId: "d1", linkUrl: linkUrl as string | null }), JSON.stringify(linkUrl)).toBe(isFigma);
  });
});

describe("isLibraryVisible (the internal Marketing library)", () => {
  it("a template with no design is always listed", () => {
    for (const [linkUrl] of LINK_VECTORS) expect(isLibraryVisible({ designId: null, linkUrl: linkUrl as string | null, canvasRevision: null })).toBe(true);
  });

  it("a template with a design is listed with a real Figma link or a revision, and not with neither", () => {
    expect(isLibraryVisible({ designId: "d1", linkUrl: null, canvasRevision: 1 })).toBe(true);
    expect(isLibraryVisible({ designId: "d1", linkUrl: "https://www.figma.com/design/A/B", canvasRevision: null })).toBe(true);
    expect(isLibraryVisible({ designId: "d1", linkUrl: null, canvasRevision: null })).toBe(false);
    expect(isLibraryVisible({ designId: "d1", linkUrl: "https://example.com", canvasRevision: null })).toBe(false);
    expect(isLibraryVisible({ designId: "d1", linkUrl: "   ", canvasRevision: null })).toBe(false);
  });
});

describe("toLibraryTemplate", () => {
  it("replaces the nested design by its latest revision number and the user by a name", () => {
    const out = toLibraryTemplate({ id: "t1", designId: "d1", design: { revisions: [{ number: 3 }] }, user: { name: "Dewi" } });
    expect(out).toEqual({ id: "t1", designId: "d1", slideImages: [], canvasRevision: 3, createdBy: "Dewi" });
    expect(out).not.toHaveProperty("design");
    expect(out).not.toHaveProperty("user");
  });

  it("no design, or a design with no revision, has no revision number", () => {
    expect(toLibraryTemplate({ id: "t", designId: null, design: null, user: null })).toMatchObject({ canvasRevision: null, createdBy: null });
    expect(toLibraryTemplate({ id: "t", designId: "d", design: { revisions: [] }, user: null })).toMatchObject({ canvasRevision: null });
  });
});

describe("the slide images of a template: two stored lists, one list in the code", () => {
  it("zips the urls with their names, in order; an empty name is none", () => {
    expect(slideImagesOf({ slideUrls: ["/a.png", "/b.png", "/c.png"], slideLabels: ["Cover", "", "Close"] })).toEqual([
      { url: "/a.png", label: "Cover" },
      { url: "/b.png", label: null },
      { url: "/c.png", label: "Close" },
    ]);
  });

  it("a row from before the columns, or with fewer names than images, still reads", () => {
    expect(slideImagesOf({})).toEqual([]);
    expect(slideImagesOf({ slideUrls: ["/a.png", "/b.png"], slideLabels: ["Cover"] })).toEqual([{ url: "/a.png", label: "Cover" }, { url: "/b.png", label: null }]);
  });

  it("writes them back as two lists of the same length, an empty name as an empty string", () => {
    const images = [{ url: "/a.png", label: "Cover" }, { url: "/b.png", label: null }];
    expect(slideColumns(images)).toEqual({ slideUrls: ["/a.png", "/b.png"], slideLabels: ["Cover", ""] });
    expect(slideImagesOf(slideColumns(images))).toEqual(images);
  });

  it("the library row carries one list of slides, and not the two columns", () => {
    const out = toLibraryTemplate({ id: "t", user: null, slideUrls: ["/a.png"], slideLabels: ["Cover"] });
    expect(out.slideImages).toEqual([{ url: "/a.png", label: "Cover" }]);
    expect(out).not.toHaveProperty("slideUrls");
    expect(out).not.toHaveProperty("slideLabels");
  });
});

describe("withoutTemplateMedia: a file a template still holds is never deleted", () => {
  beforeEach(() => {
    db.templates = [];
    db.legacy = [];
  });

  it("keeps a preview, a slide image and a legacy kit file, and frees the others", async () => {
    db.templates = [{ previewUrl: "/p.png", slideUrls: [] }, { previewUrl: null, slideUrls: ["/s1.png", "/s2.png"] }];
    db.legacy = ["/k.png"];
    expect(await withoutTemplateMedia(["/p.png", "/s1.png", "/s2.png", "/k.png", "/free.png"])).toEqual(["/free.png"]);
  });

  it("a slide image that no template holds any more is free", async () => {
    db.templates = [{ previewUrl: null, slideUrls: ["/s1.png"] }];
    expect(await withoutTemplateMedia(["/s2.png"])).toEqual(["/s2.png"]);
  });

  it("no urls, no query", async () => {
    expect(await withoutTemplateMedia([])).toEqual([]);
  });
});
