// @vitest-environment jsdom
// The design reference shown next to a post (Compose, the review dialog, the edit dialog, the content drawer). It must
// never be an empty card: a template with a Figma link opens it, a template designed in Canvas says so, and a legacy
// template with some other link still opens that link.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DesignTemplate } from "@/lib/templates";
import { DesignReferenceCard } from "./DesignReferenceCard";

const t = (patch: Partial<DesignTemplate> = {}): DesignTemplate => ({
  id: "t1", name: "Case Study", pillar: "Promotional", category: "Case Study", linkUrl: "https://www.figma.com/design/AbC/Case",
  previewUrl: null, published: true, format: null, slides: null, platforms: [], slideImages: [], captionGuideline: null, createdAt: "2026-11-12T03:00:00.000Z", createdBy: null, ...patch,
});
const show = (template: DesignTemplate | null) => render(<DesignReferenceCard template={template} category="Case Study" />);
afterEach(cleanup);

describe("DesignReferenceCard", () => {
  it("a Figma template opens in Figma, as before", () => {
    show(t());
    expect(screen.getByRole("link", { name: /Open in Figma/ }).getAttribute("href")).toBe("https://www.figma.com/design/AbC/Case");
  });

  it("a template designed in Canvas (no link, a revision) says so instead of showing an empty card", () => {
    show(t({ linkUrl: null, designId: "d1", canvasRevision: 2 }));
    expect(screen.getByText("Designed in Canvas by the design team.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Figma link not added yet.")).toBeNull();
  });

  it("a template with no link and no Canvas revision says the link is missing", () => {
    show(t({ linkUrl: null }));
    expect(screen.getByText("Figma link not added yet.")).toBeTruthy();
    show(t({ linkUrl: "   " }));
    expect(screen.getAllByText("Figma link not added yet.")).toHaveLength(2);
  });

  it("a legacy template whose link is not a Figma design still opens that link", () => {
    show(t({ linkUrl: "https://drive.example.com/file/1" }));
    expect(screen.getByRole("link", { name: /Open link/ }).getAttribute("href")).toBe("https://drive.example.com/file/1");
    expect(screen.queryByText("Figma link not added yet.")).toBeNull();
  });

  it("a Figma link wins over a Canvas design", () => {
    show(t({ designId: "d1", canvasRevision: 3 }));
    expect(screen.getByRole("link", { name: /Open in Figma/ })).toBeTruthy();
    expect(screen.queryByText(/Designed in Canvas/)).toBeNull();
  });

  it("says there is no template for a category that has none", () => {
    show(null);
    expect(screen.getByText(/No design template for Case Study yet/)).toBeTruthy();
  });
});

describe("DesignReferenceCard: the caption guideline", () => {
  it("shows what the design team wrote, with its line breaks, next to the design", () => {
    show(t({ captionGuideline: "Open with the problem.\nClose with one call to action." }));
    const text = screen.getByText(/Open with the problem\./);
    expect(text.textContent).toContain("Close with one call to action.");
    expect(text.className).toContain("whitespace-pre-line");
    expect(screen.getByText("Caption guideline")).toBeTruthy();
  });

  it("a template with no guideline shows no empty heading", () => {
    show(t());
    expect(screen.queryByText("Caption guideline")).toBeNull();
  });

  it("is still shown for a template designed in Canvas (no link)", () => {
    show(t({ linkUrl: null, designId: "d1", canvasRevision: 1, captionGuideline: "Be brief." }));
    expect(screen.getByText("Be brief.")).toBeTruthy();
  });
});
