// What counts as a template's source on the page. These are the SAME vectors as apps/api/src/lib/templates.test.ts, on
// purpose: the two copies of the helpers must agree on every one, so the page never says a template has a usable source
// that the API would refuse to publish.
import { describe, expect, it } from "vitest";
import { hasCanvasSource, hasFigmaSource, hasUsableSource, isIncomplete } from "./templates";

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

describe("hasCanvasSource and hasUsableSource", () => {
  it("a Canvas source is a revision number, and nothing else", () => {
    expect(hasCanvasSource(1)).toBe(true);
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
});

describe("isIncomplete says what the API would refuse", () => {
  it("a whitespace link is incomplete (it is truthy, but it is not a source)", () => {
    expect(isIncomplete({ linkUrl: "   ", canvasRevision: null })).toBe(true);
  });

  it("a link that is not a Figma design is incomplete", () => {
    expect(isIncomplete({ linkUrl: "https://example.com", canvasRevision: null })).toBe(true);
  });

  it("a real Figma link, or a Canvas revision, is complete", () => {
    expect(isIncomplete({ linkUrl: "https://www.figma.com/design/A/B", canvasRevision: null })).toBe(false);
    expect(isIncomplete({ linkUrl: null, canvasRevision: 1 })).toBe(false);
  });

  it("nothing at all is incomplete", () => {
    expect(isIncomplete({ linkUrl: null, canvasRevision: null })).toBe(true);
    expect(isIncomplete({ linkUrl: null })).toBe(true);
  });

  it("agrees with hasUsableSource for every vector", () => {
    for (const [linkUrl] of LINK_VECTORS) {
      const t = { linkUrl: linkUrl as string | null, canvasRevision: null };
      expect(isIncomplete(t)).toBe(!hasUsableSource(t));
    }
  });
});
