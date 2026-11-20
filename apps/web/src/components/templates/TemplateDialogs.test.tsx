// @vitest-environment jsdom
// What the Unpublish and Delete dialogs show WHILE THEY CLOSE. A real dialog fades out for a moment after Cancel, and jsdom has no
// animation (it removes the dialog at once), so ConfirmDialog is replaced here by one that always draws what it was given, with its
// `open` flag on the outside. That makes the closing frame something a test can look at.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DesignTemplate } from "@/lib/templates";

const h = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u }));
vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: (p: { open: boolean; title: string; description?: string; children?: React.ReactNode }) => (
    <section data-testid="dialog" data-open={String(p.open)}>
      <h2>{p.title}</h2>
      <p>{p.description}</p>
      {p.children}
    </section>
  ),
}));

import { DeleteTemplateDialog, UnpublishTemplateDialog } from "./TemplateDialogs";

const CASE: DesignTemplate = {
  id: "case",
  name: "Case Study",
  pillar: "Promotional",
  category: "Case Study",
  linkUrl: "https://www.figma.com/design/AbC/Case-Study",
  previewUrl: null,
  published: true,
  format: "carousel",
  slides: 5,
  platforms: ["linkedin"],
  slideImages: [],
  captionGuideline: null,
  createdAt: "2026-11-12T03:00:00.000Z",
  updatedAt: "2026-11-13T03:00:00.000Z",
  createdBy: "Dewi Kusuma",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.apiFetch.mockResolvedValue({ created: 12, inReview: 3 });
});
afterEach(cleanup);

const noop = async () => {};
const dialog = () => screen.getByTestId("dialog");

describe.each([
  ["Unpublish", "Unpublish Case Study?", "Draft · hidden from Marketing", UnpublishTemplateDialog, "3 posts in review use this template"],
  ["Delete", "Delete Case Study?", "Dewi K. · 12 Nov 2026", DeleteTemplateDialog, "12 posts are of this category"],
] as const)("%s dialog: the closing frame is the open one", (_name, title, fact, Dialog, boxTitle) => {
  it("keeps its title, its summary and its red box after the page clears the template (Cancel)", async () => {
    const { rerender } = render(<Dialog template={CASE} onOpenChange={() => {}} onConfirm={noop} />);
    await waitFor(() => expect(screen.getByRole("note").textContent).toContain(boxTitle));
    rerender(<Dialog template={null} onOpenChange={() => {}} onConfirm={noop} />);
    expect(dialog().getAttribute("data-open")).toBe("false");
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(fact)).toBeTruthy();
    expect(screen.getByText("Case Study", { selector: "p" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain(boxTitle);
  });

  it("does not change under an open dialog: a template that reloads as a Draft does not flip the badge while it closes", async () => {
    const { rerender } = render(<Dialog template={CASE} onOpenChange={() => {}} onConfirm={noop} />);
    await waitFor(() => expect(screen.getByRole("note")).toBeTruthy());
    expect(screen.getByText("Published")).toBeTruthy();
    // Unpublish went through: the page reloads the template as a draft and clears the dialog in the same breath
    rerender(<Dialog template={null} onOpenChange={() => {}} onConfirm={noop} />);
    expect(screen.getByText("Published")).toBeTruthy();
    expect(screen.queryByText("Draft", { selector: "span" })).toBeNull();
  });

  it("a dialog opened a second time starts empty: the last count is not shown while its own is on the way", async () => {
    const { rerender } = render(<Dialog template={CASE} onOpenChange={() => {}} onConfirm={noop} />);
    await waitFor(() => expect(screen.getByRole("note")).toBeTruthy());
    rerender(<Dialog template={null} onOpenChange={() => {}} onConfirm={noop} />);
    h.apiFetch.mockReturnValueOnce(new Promise(() => {})); // the answer never comes
    rerender(<Dialog template={CASE} onOpenChange={() => {}} onConfirm={noop} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(dialog().getAttribute("data-open")).toBe("true");
  });

  it("opens for the next template with that template's own content", async () => {
    const { rerender } = render(<Dialog template={CASE} onOpenChange={() => {}} onConfirm={noop} />);
    rerender(<Dialog template={null} onOpenChange={() => {}} onConfirm={noop} />);
    rerender(<Dialog template={{ ...CASE, id: "blog", category: "Blog Post", published: false }} onOpenChange={() => {}} onConfirm={noop} />);
    expect(screen.getByRole("heading", { name: title.replace("Case Study", "Blog Post") })).toBeTruthy();
  });
});
