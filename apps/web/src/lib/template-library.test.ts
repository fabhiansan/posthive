import { describe, expect, it } from "vitest";
import {
  NO_FILTERS,
  PAGE_SIZE,
  createdLine,
  filterTemplates,
  footerLine,
  formatText,
  isFiltered,
  libraryCounts,
  linkLabel,
  marketingLine,
  pageOf,
  platformsText,
  subLine,
  toCsv,
} from "./template-library";
import type { DesignTemplate } from "./templates";

const t = (patch: Partial<DesignTemplate> = {}): DesignTemplate => ({
  id: "t1",
  name: "Case Study",
  pillar: "Promotional",
  category: "Case Study",
  linkUrl: "https://www.figma.com/design/Pt3mPl8/Insight-Carousel",
  previewUrl: null,
  published: true,
  format: "carousel",
  slides: 5,
  platforms: ["linkedin", "instagram"],
  createdAt: "2026-11-12T03:00:00.000Z",
  createdBy: "Dewi Kusuma",
  ...patch,
});

describe("what a card says", () => {
  it("format: a carousel counts its slides; reel and story show the ratio; the rest are their name", () => {
    expect(formatText(t())).toBe("Carousel · 5 slides");
    expect(formatText(t({ slides: null }))).toBe("Carousel");
    expect(formatText(t({ format: "single", slides: null }))).toBe("Single image");
    expect(formatText(t({ format: "reel_cover", slides: null }))).toBe("Reel cover · 9:16");
    expect(formatText(t({ format: "story", slides: null }))).toBe("Story · 9:16");
    expect(formatText(t({ format: "video", slides: null }))).toBe("Video");
    expect(formatText(t({ format: null, slides: null }))).toBeNull();
  });

  it("the line under the title: pillar and format, each saying so when it is missing", () => {
    expect(subLine(t())).toBe("Promotional · Carousel · 5 slides");
    expect(subLine(t({ pillar: null, format: null, slides: null }))).toBe("No pillar · No format yet");
  });

  it("platforms are named and joined; none is nothing", () => {
    expect(platformsText(["linkedin", "instagram"])).toBe("LinkedIn · Instagram");
    expect(platformsText([])).toBeNull();
  });

  it("the link has no scheme, no www and no closing slash; no link says so", () => {
    expect(linkLabel("https://www.figma.com/design/Pt3mPl8/Insight-Carousel")).toBe("figma.com/design/Pt3mPl8/Insight-Carousel");
    expect(linkLabel("http://figma.com/file/x/")).toBe("figma.com/file/x");
    expect(linkLabel(null)).toBe("No Figma link yet");
  });

  it("created: the WIB day and the short name; 17:30 UTC is already the next day in Jakarta; the person is left out when gone", () => {
    expect(createdLine(t())).toBe("Created 12 Nov 2026 · Dewi K.");
    expect(createdLine(t({ createdAt: "2026-11-12T17:30:00.000Z" }))).toBe("Created 13 Nov 2026 · Dewi K.");
    expect(createdLine(t({ createdBy: null }))).toBe("Created 12 Nov 2026");
    expect(createdLine(t({ createdAt: "nope" }))).toBe("");
  });
});

describe("filterTemplates", () => {
  const list = [
    t({ id: "a", category: "Case Study", createdAt: "2026-11-12T00:00:00.000Z" }),
    t({ id: "b", category: "Blog Post", pillar: "Educational", format: "single", slides: null, platforms: ["instagram"], published: false, createdAt: "2026-11-10T00:00:00.000Z" }),
    t({ id: "c", category: "Ask Me Anything", pillar: null, format: null, slides: null, platforms: [], createdAt: "2026-11-14T00:00:00.000Z" }),
  ];
  const ids = (f: Partial<typeof NO_FILTERS>) => filterTemplates(list, { ...NO_FILTERS, ...f }).map((x) => x.id);

  it("no filter: all of them, newest created first", () => {
    expect(ids({})).toEqual(["c", "a", "b"]);
  });

  it("by status", () => {
    expect(ids({ status: "published" })).toEqual(["c", "a"]);
    expect(ids({ status: "draft" })).toEqual(["b"]);
  });

  it("by pillar; 'none' is the one outside the four pillars", () => {
    expect(ids({ pillar: "Educational" })).toEqual(["b"]);
    expect(ids({ pillar: "none" })).toEqual(["c"]);
  });

  it("by format and by platform; a template with no platform is in no platform", () => {
    expect(ids({ format: "single" })).toEqual(["b"]);
    expect(ids({ platform: "instagram" })).toEqual(["a", "b"]);
    expect(ids({ platform: "linkedin" })).toEqual(["a"]);
  });

  it("by search: the category, the pillar or the format, ignoring case and spaces around", () => {
    expect(ids({ q: "  BLOG " })).toEqual(["b"]);
    expect(ids({ q: "educational" })).toEqual(["b"]);
    expect(ids({ q: "carousel" })).toEqual(["a"]);
    expect(ids({ q: "nothing like this" })).toEqual([]);
  });

  it("filters add up", () => {
    expect(ids({ status: "published", platform: "instagram" })).toEqual(["a"]);
    expect(ids({ status: "draft", platform: "linkedin" })).toEqual([]);
  });

  it("two made at the same moment keep a steady order", () => {
    const same = [t({ id: "x" }), t({ id: "y" })];
    expect(filterTemplates(same, NO_FILTERS).map((x) => x.id)).toEqual(["y", "x"]);
  });

  it("isFiltered says whether anything is set", () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, q: "x" })).toBe(true);
    expect(isFiltered({ ...NO_FILTERS, status: "draft" })).toBe(true);
  });
});

describe("libraryCounts", () => {
  it("total, published, draft; pillars covered counts the published ones only, and not 'No pillar'", () => {
    const list = [
      t({ id: "1", pillar: "Promotional" }),
      t({ id: "2", pillar: "Promotional" }),
      t({ id: "3", pillar: "Educational", published: false }),
      t({ id: "4", pillar: null }),
    ];
    expect(libraryCounts(list)).toEqual({ total: 4, published: 3, draft: 1, pillars: 1 });
    expect(libraryCounts([])).toEqual({ total: 0, published: 0, draft: 0, pillars: 0 });
  });
});

describe("pageOf", () => {
  const many = Array.from({ length: 20 }, (_, i) => t({ id: String(i) }));

  it(`${PAGE_SIZE} to a page`, () => {
    const p = pageOf(many, 1);
    expect(p.items).toHaveLength(PAGE_SIZE);
    expect(p).toMatchObject({ page: 1, pageCount: 3 });
    expect(pageOf(many, 3).items).toHaveLength(4);
  });

  it("a page past the end is the last, one before the start is the first, and an empty list is one empty page", () => {
    expect(pageOf(many, 9).page).toBe(3);
    expect(pageOf(many, 0).page).toBe(1);
    expect(pageOf([], 1)).toEqual({ items: [], page: 1, pageCount: 1 });
  });
});

describe("the sentences", () => {
  it("footer: drafts are mentioned for the design team only", () => {
    expect(footerLine(8, 24, true)).toBe("Showing 8 of 24 templates · Drafts are visible to Designers only");
    expect(footerLine(1, 1, false)).toBe("Showing 1 of 1 template");
  });

  it("what Marketing sees", () => {
    expect(marketingLine({ total: 24, published: 18, draft: 6, pillars: 4 })).toBe("Marketing currently sees 18 published templates across 4 content pillars.");
    expect(marketingLine({ total: 2, published: 1, draft: 1, pillars: 1 })).toBe("Marketing currently sees 1 published template across 1 content pillar.");
    expect(marketingLine({ total: 3, published: 0, draft: 3, pillars: 0 })).toBe("Marketing currently sees no published templates.");
  });
});

describe("toCsv", () => {
  it("a header and a row per template, in the order given; the status, the platforms and the WIB day", () => {
    const csv = toCsv([t(), t({ category: "Blog Post", pillar: "Educational", published: false, format: null, slides: null, platforms: [], linkUrl: null, createdBy: null })]);
    expect(csv.split("\r\n")).toEqual([
      '"Category","Pillar","Format","Platforms","Status","Figma link","Created","Created by"',
      '"Case Study","Promotional","Carousel · 5 slides","LinkedIn, Instagram","Published","https://www.figma.com/design/Pt3mPl8/Insight-Carousel","2026-11-12","Dewi Kusuma"',
      '"Blog Post","Educational","","","Draft","","2026-11-12",""',
      "",
    ]);
  });

  it("a quote inside a cell is doubled", () => {
    expect(toCsv([t({ createdBy: 'Dewi "D" K' })])).toContain('"Dewi ""D"" K"');
  });

  it("a cell a spreadsheet would run as a formula starts with a quote mark instead", () => {
    const csv = toCsv([t({ createdBy: "=HYPERLINK(\"http://x\")", linkUrl: "+1" })]);
    expect(csv).toContain('"\'=HYPERLINK(""http://x"")"');
    expect(csv).toContain(`"'+1"`);
  });

  it("no templates: only the header", () => {
    expect(toCsv([]).split("\r\n")).toHaveLength(2);
  });
});
