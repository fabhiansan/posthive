// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesignTemplate } from "@/lib/templates";

const h = vi.hoisted(() => ({ apiFetch: vi.fn(), uploads: 0, deleted: [] as string[] }));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch }));

import { TemplateEditor } from "./TemplateEditor";

const saved: DesignTemplate = {
  id: "t1", name: "Case Study", pillar: "Promotional", category: "Case Study", linkUrl: "https://www.figma.com/design/AbC/Case",
  previewUrl: null, published: false, format: null, slides: null, platforms: [], slideImages: [], captionGuideline: null, createdAt: "2026-11-12T03:00:00.000Z", createdBy: "Dewi Kusuma",
};
const onSaved = vi.fn();
const onClose = vi.fn();

const open = (template: DesignTemplate | null = null) =>
  render(<TemplateEditor template={template} takenCategories={new Set()} onClose={onClose} onSaved={onSaved} />);

const sent = () => JSON.parse(h.apiFetch.mock.calls[0][1].body);

/** What a person does first in a new template: picks the category (the pillar follows it). */
const pickCategory = () => userEvent.selectOptions(screen.getByLabelText("Content category"), "Case Study");

beforeEach(() => {
  vi.clearAllMocks();
  h.uploads = 0;
  h.deleted = [];
  h.apiFetch.mockImplementation(async (path: string) => (path === "/upload" ? { url: `/uploads/new-${++h.uploads}.png` } : { template: saved }));
  // discardUpload() asks the API to delete a file it uploaded and nobody saved
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => { h.deleted.push(JSON.parse(init!.body!).url); return { ok: true }; }));
});
afterEach(cleanup);

describe("TemplateEditor: format and platforms", () => {
  it("a new template asks for nothing but the category and the link: format, slides and platforms are left out", async () => {
    open();
    await pickCategory();
    await userEvent.type(screen.getByLabelText("Figma link"), "https://www.figma.com/design/AbC/Case");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalled());
    expect(h.apiFetch.mock.calls[0][0]).toBe("/templates");
    expect(sent()).toMatchObject({ category: "Case Study", format: null, slides: null, platforms: [] });
    expect(sent()).not.toHaveProperty("published");
  });

  it("a carousel asks for its slides; the format, the slides and the chosen platforms are sent", async () => {
    open();
    await pickCategory();
    await userEvent.type(screen.getByLabelText("Figma link"), "https://www.figma.com/design/AbC/Case");
    expect(screen.queryByLabelText(/^Slides/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText(/^Content format/), "carousel");
    await userEvent.type(screen.getByLabelText(/^Slides/), "6");
    await userEvent.click(screen.getByRole("button", { name: "LinkedIn" }));
    await userEvent.click(screen.getByRole("button", { name: "Instagram" }));
    await userEvent.click(screen.getByRole("button", { name: "LinkedIn" })); // off again
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalled());
    expect(sent()).toMatchObject({ format: "carousel", slides: 6, platforms: ["instagram"] });
  });

  it("another format sends no slides, even if a carousel had some typed in", async () => {
    open();
    await pickCategory();
    await userEvent.type(screen.getByLabelText("Figma link"), "https://www.figma.com/design/AbC/Case");
    await userEvent.selectOptions(screen.getByLabelText(/^Content format/), "carousel");
    await userEvent.type(screen.getByLabelText(/^Slides/), "6");
    await userEvent.selectOptions(screen.getByLabelText(/^Content format/), "single");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalled());
    expect(sent()).toMatchObject({ format: "single", slides: null });
  });

  it("slides outside 2 to 20 are refused before anything is sent", async () => {
    open();
    await pickCategory();
    await userEvent.type(screen.getByLabelText("Figma link"), "https://www.figma.com/design/AbC/Case");
    await userEvent.selectOptions(screen.getByLabelText(/^Content format/), "carousel");
    await userEvent.type(screen.getByLabelText(/^Slides/), "1");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A carousel has 2 to 20 slides.");
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("editing starts from what the template has, and PATCHes it", async () => {
    open({ ...saved, format: "carousel", slides: 5, platforms: ["linkedin"] });
    expect((screen.getByLabelText(/^Slides/) as HTMLInputElement).value).toBe("5");
    expect(screen.getByRole("button", { name: "LinkedIn" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Instagram" }).getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalled());
    expect(h.apiFetch.mock.calls[0][0]).toBe("/templates/t1");
    expect(h.apiFetch.mock.calls[0][1].method).toBe("PATCH");
    expect(sent()).toMatchObject({ format: "carousel", slides: 5, platforms: ["linkedin"] });
  });
});

describe("TemplateEditor: the Figma link is optional (a template can be designed in Canvas)", () => {
  it("a new template with no link is saved as a draft with linkUrl null", async () => {
    open();
    await pickCategory();
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalled());
    expect(sent().linkUrl).toBeNull();
    expect(h.apiFetch.mock.calls[0][0]).toBe("/templates");
    expect(sent()).not.toHaveProperty("published");
  });

  it("a link of only spaces is no link: it is sent as null, not as spaces", async () => {
    open();
    await pickCategory();
    await userEvent.type(screen.getByLabelText("Figma link"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalled());
    expect(sent().linkUrl).toBeNull();
  });

  it("a link that is given and is not a Figma design is still refused before anything is sent", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Figma link"), "https://example.com");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    expect((await screen.findAllByText(/Use a Figma link/)).length).toBeGreaterThan(0);
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("says when a link is not needed, and what the template needs to be published", () => {
    open();
    expect(screen.getByText(/Optional when the template is designed in Canvas/)).toBeTruthy();
    expect(screen.getByText(/Figma link or a published Canvas revision before it can be published/)).toBeTruthy();
  });

  it("editing a template to remove its link sends null (the API decides whether that is allowed)", async () => {
    open({ ...saved });
    await userEvent.clear(screen.getByLabelText("Figma link"));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalled());
    expect(sent().linkUrl).toBeNull();
    expect(h.apiFetch.mock.calls[0][1].method).toBe("PATCH");
  });

  it("a refusal from the API (the template is published and this is its only source) is shown in the dialog", async () => {
    h.apiFetch.mockRejectedValueOnce(new Error("This template is published and this is its only source."));
    open({ ...saved });
    await userEvent.clear(screen.getByLabelText("Figma link"));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain("only source");
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("TemplateEditor: removing the Figma link of a published template that has a Canvas design", () => {
  const withCanvas = { ...saved, published: true, designId: "d1", canvasRevision: 1 };
  const WARNING = /no longer returned by the public API and MCP/;

  it("warns once the link is cleared, because the public API and MCP list a template with a Canvas design only through its Figma link", async () => {
    open(withCanvas);
    expect(screen.queryByText(WARNING)).toBeNull(); // not while the link is still there
    await userEvent.clear(screen.getByLabelText("Figma link"));
    expect(screen.getByText(WARNING)).toBeTruthy();
    expect(screen.getByText(/Marketing still sees it in the library/)).toBeTruthy();
  });

  it("the warning goes away when a link is typed again", async () => {
    open(withCanvas);
    await userEvent.clear(screen.getByLabelText("Figma link"));
    await userEvent.type(screen.getByLabelText("Figma link"), "https://www.figma.com/design/AbC/Case");
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it("says nothing for a draft, a template with no Canvas design, or a new template", async () => {
    for (const template of [{ ...withCanvas, published: false }, { ...saved, published: true }, null]) {
      const { unmount } = open(template);
      await userEvent.clear(screen.getByLabelText("Figma link"));
      expect(screen.queryByText(WARNING)).toBeNull();
      unmount();
    }
  });

  it("says nothing for a template whose stored link was not a Figma design to begin with", async () => {
    open({ ...withCanvas, linkUrl: "https://example.com" });
    await userEvent.clear(screen.getByLabelText("Figma link"));
    expect(screen.queryByText(WARNING)).toBeNull();
  });
});

// ── Slide images and the caption guideline ──────────────────────────────────────────────────────────────────────────

const png = (name: string) => new File(["x"], name, { type: "image/png" });
const slidesInput = () => document.querySelectorAll<HTMLInputElement>('input[type="file"]')[0];
const apiCalls = (path: string) => h.apiFetch.mock.calls.filter(([p]) => p === path);
const saveBody = () => JSON.parse(h.apiFetch.mock.calls.filter(([p]) => p !== "/upload").at(-1)![1].body);
const carousel = async () => {
  open();
  await pickCategory();
  await userEvent.selectOptions(screen.getByLabelText(/^Content format/), "carousel");
};
const upload = async (...names: string[]) => {
  await userEvent.upload(slidesInput(), names.map(png));
  await waitFor(() => expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(names.length));
};
const names = () => screen.getAllByLabelText(/^Name of slide/) as HTMLInputElement[];

describe("TemplateEditor: slide images", () => {
  it("only a carousel is asked for them", async () => {
    open();
    await pickCategory();
    expect(screen.queryByText(/Upload slide images/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText(/^Content format/), "single");
    expect(screen.queryByText(/Upload slide images/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText(/^Content format/), "carousel");
    expect(screen.getByRole("button", { name: "Upload slide images" })).toBeTruthy();
  });

  it("uploads several pictures at once, in the order picked, and each gets a name box", async () => {
    await carousel();
    await upload("a.png", "b.png", "c.png");
    expect(apiCalls("/upload")).toHaveLength(3);
    expect(names().map((n) => n.placeholder)).toEqual(["Slide 1", "Slide 2", "Slide 3"]);
    expect(screen.getByRole("button", { name: "Add slide images" })).toBeTruthy();
  });

  it("the number of slides is the number of pictures: the typed count goes away", async () => {
    await carousel();
    expect(screen.getByLabelText(/^Slides/)).toBeTruthy();
    await upload("a.png", "b.png");
    expect(screen.queryByLabelText(/^Slides/)).toBeNull();
  });

  it("saving sends the pictures in order with their names (a blank name is null) and the count of them", async () => {
    await carousel();
    await upload("a.png", "b.png", "c.png");
    await userEvent.type(names()[0], "Cover");
    await userEvent.type(names()[2], "  Call to action  ");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(apiCalls("/templates")).toHaveLength(1));
    expect(saveBody()).toMatchObject({
      format: "carousel",
      slides: 3,
      slideImages: [{ url: "/uploads/new-1.png", label: "Cover" }, { url: "/uploads/new-2.png", label: null }, { url: "/uploads/new-3.png", label: "Call to action" }],
    });
  });

  it("a picture can be moved up and down, and the first cannot go up nor the last down", async () => {
    await carousel();
    await upload("a.png", "b.png", "c.png");
    await userEvent.type(names()[2], "Last");
    expect((screen.getByRole("button", { name: "Move slide 1 up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move slide 3 down" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Move slide 3 up" }));
    await userEvent.click(screen.getByRole("button", { name: "Move slide 2 up" }));
    expect(names().map((n) => n.value)).toEqual(["Last", "", ""]); // the name travels with its picture
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(apiCalls("/templates")).toHaveLength(1));
    expect(saveBody().slideImages.map((s: { url: string }) => s.url)).toEqual(["/uploads/new-3.png", "/uploads/new-1.png", "/uploads/new-2.png"]);
  });

  it("removing a picture just uploaded takes it out of storage too, and the rest keep their order", async () => {
    await carousel();
    await upload("a.png", "b.png", "c.png");
    await userEvent.click(screen.getByRole("button", { name: "Remove slide 2" }));
    expect(names()).toHaveLength(2);
    expect(h.deleted).toEqual(["/uploads/new-2.png"]);
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(apiCalls("/templates")).toHaveLength(1));
    expect(saveBody().slideImages.map((s: { url: string }) => s.url)).toEqual(["/uploads/new-1.png", "/uploads/new-3.png"]);
  });

  it("removing a picture that was already saved keeps its file: the API removes it when the edit is saved", async () => {
    open({ ...saved, format: "carousel", slides: 2, slideImages: [{ url: "/uploads/s1.png", label: "Cover" }, { url: "/uploads/s2.png", label: null }, { url: "/uploads/s3.png", label: null }] });
    expect(names().map((n) => n.value)).toEqual(["Cover", "", ""]);
    await userEvent.click(screen.getByRole("button", { name: "Remove slide 3" }));
    expect(h.deleted).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(apiCalls("/templates/t1")).toHaveLength(1));
    expect(saveBody().slideImages).toEqual([{ url: "/uploads/s1.png", label: "Cover" }, { url: "/uploads/s2.png", label: null }]);
  });

  it("one picture is not a carousel: refused before anything is sent", async () => {
    await carousel();
    await upload("a.png");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    // the message that tells what to do about ONE picture (the general 2 to 20 rule would also fire without it)
    expect((await screen.findByRole("alert")).textContent).toBe("A carousel has 2 to 20 slides. Add another slide image, or remove this one.");
    expect(apiCalls("/templates")).toHaveLength(0);
  });

  it("one picture is refused even when a count of 5 was typed before the picture was added", async () => {
    await carousel();
    await userEvent.type(screen.getByLabelText(/^Slides/), "5");
    await upload("a.png");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Add another slide image");
    expect(apiCalls("/templates")).toHaveLength(0);
  });

  it("at most 20: the ones that fit are added, and it says so", async () => {
    open({ ...saved, format: "carousel", slideImages: Array.from({ length: 19 }, (_, i) => ({ url: `/uploads/s${i}.png`, label: null })) });
    await userEvent.upload(slidesInput(), [png("a.png"), png("b.png"), png("c.png")]);
    await waitFor(() => expect(names()).toHaveLength(20));
    expect(apiCalls("/upload")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("at most 20 slides. The first 1 were added.");
    expect((screen.getByRole("button", { name: "Add slide images" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a picture that fails to upload is named, and the others still arrive", async () => {
    h.apiFetch.mockImplementation(async (path: string, init?: { body?: unknown }) => {
      if (path !== "/upload") return { template: saved };
      const name = ((init!.body as FormData).get("file") as File).name;
      if (name === "bad.png") throw new Error("File too large");
      return { url: `/uploads/${name}` };
    });
    await carousel();
    await userEvent.upload(slidesInput(), [png("a.png"), png("bad.png"), png("c.png")]);
    await waitFor(() => expect(names()).toHaveLength(2));
    expect(screen.getByRole("alert").textContent).toBe("bad.png: File too large");
  });

  it("Cancel takes the pictures uploaded in this session out of storage, and keeps the saved ones", async () => {
    open({ ...saved, format: "carousel", slideImages: [{ url: "/uploads/saved1.png", label: null }, { url: "/uploads/saved2.png", label: null }] });
    await upload("a.png");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.deleted).toEqual(["/uploads/new-1.png"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("changing the format away from carousel sends no pictures, and takes the unsaved ones out of storage", async () => {
    await carousel();
    await upload("a.png", "b.png");
    await userEvent.selectOptions(screen.getByLabelText(/^Content format/), "single");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(apiCalls("/templates")).toHaveLength(1));
    expect(saveBody()).toMatchObject({ format: "single", slides: null, slideImages: [] });
    expect(h.deleted.sort()).toEqual(["/uploads/new-1.png", "/uploads/new-2.png"]);
  });

  it("the name of a slide is at most 40 characters", async () => {
    await carousel();
    await upload("a.png", "b.png");
    expect(names()[0].maxLength).toBe(40);
  });
});

describe("TemplateEditor: the caption guideline", () => {
  const box = () => screen.getByLabelText(/^Caption guideline/) as HTMLTextAreaElement;

  it("starts empty for a new template and from what the template has when editing", () => {
    open();
    expect(box().value).toBe("");
    cleanup();
    open({ ...saved, captionGuideline: "Open with the problem." });
    expect(box().value).toBe("Open with the problem.");
  });

  it("is sent trimmed; a blank one is sent as null", async () => {
    open();
    await pickCategory();
    await userEvent.type(box(), "  Open with the problem.  ");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(apiCalls("/templates")).toHaveLength(1));
    expect(saveBody().captionGuideline).toBe("Open with the problem.");

    cleanup();
    h.apiFetch.mockClear();
    open();
    await pickCategory();
    await userEvent.type(box(), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(apiCalls("/templates")).toHaveLength(1));
    expect(saveBody().captionGuideline).toBeNull();
  });

  it("counts its characters out of 2000, and cannot go past it", async () => {
    open();
    expect(screen.getByText("0 / 2000")).toBeTruthy();
    await userEvent.type(box(), "Hello");
    expect(screen.getByText("5 / 2000")).toBeTruthy();
    expect(box().maxLength).toBe(2000);
  });

  it("says it is a guide that is never copied into a post", () => {
    open();
    expect(screen.getByText(/never copied into a post/)).toBeTruthy();
  });
});
