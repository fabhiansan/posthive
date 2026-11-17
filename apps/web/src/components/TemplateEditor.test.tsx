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
  render(<TemplateEditor template={template} presetCategory="Case Study" takenCategories={new Set()} onClose={onClose} onSaved={onSaved} />);

const sent = () => JSON.parse(h.apiFetch.mock.calls[0][1].body);

beforeEach(() => {
  vi.clearAllMocks();
  h.apiFetch.mockResolvedValue({ template: saved });
});
afterEach(cleanup);

describe("TemplateEditor: format and platforms", () => {
  it("a new template asks for nothing but the link: format, slides and platforms are left out", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Figma link"), "https://www.figma.com/design/AbC/Case");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalled());
    expect(h.apiFetch.mock.calls[0][0]).toBe("/templates");
    expect(sent()).toMatchObject({ category: "Case Study", format: null, slides: null, platforms: [] });
    expect(sent()).not.toHaveProperty("published");
  });

  it("a carousel asks for its slides; the format, the slides and the chosen platforms are sent", async () => {
    open();
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
