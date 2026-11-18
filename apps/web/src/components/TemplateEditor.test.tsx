// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesignTemplate } from "@/lib/templates";

const h = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch }));

import { TemplateEditor } from "./TemplateEditor";

const saved: DesignTemplate = {
  id: "t1", name: "Case Study", pillar: "Promotional", category: "Case Study", linkUrl: "https://www.figma.com/design/AbC/Case",
  previewUrl: null, published: false, format: null, slides: null, platforms: [], createdAt: "2026-11-12T03:00:00.000Z", createdBy: "Dewi Kusuma",
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
  h.apiFetch.mockResolvedValue({ template: saved });
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
