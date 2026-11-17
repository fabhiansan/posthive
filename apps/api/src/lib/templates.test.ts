// What counts as a template's source, and who may be shown a template. The same vectors are in
// apps/web/src/lib/templates.test.ts: the two copies of these helpers must agree on every one of them.
import { describe, expect, it } from "vitest";
// A test is the one place the API may reach into apps/web (as the canvas tests reach into apps/canvas): the page's own copy of the helpers.
import * as web from "../../../web/src/lib/templates";
import { hasCanvasSource, hasFigmaSource, hasUsableSource, isExternallyVisible, isLibraryVisible, sourceOf, toLibraryTemplate } from "./templates.js";

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
    expect(out).toEqual({ id: "t1", designId: "d1", canvasRevision: 3, createdBy: "Dewi" });
    expect(out).not.toHaveProperty("design");
    expect(out).not.toHaveProperty("user");
  });

  it("no design, or a design with no revision, has no revision number", () => {
    expect(toLibraryTemplate({ id: "t", designId: null, design: null, user: null })).toMatchObject({ canvasRevision: null, createdBy: null });
    expect(toLibraryTemplate({ id: "t", designId: "d", design: { revisions: [] }, user: null })).toMatchObject({ canvasRevision: null });
  });
});
