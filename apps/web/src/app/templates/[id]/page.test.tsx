// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesignTemplate } from "@/lib/templates";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  push: vi.fn(),
  role: "designer" as string,
  id: "case",
  toast: { toast: vi.fn(), success: vi.fn(), error: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  // what the page asked useToast for: the Template Library puts its toasts under the header
  toastPosition: vi.fn(),
  usage: { created: 0, inReview: 0 } as { created: number; inReview: number },
}));

vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { name: "Dewi Kusuma", role: h.role } }) }));
vi.mock("@/context/WorkspaceContext", () => ({
  useWorkspace: () => ({ activeWorkspace: { id: "ws-1", name: "Braga Tech", role: h.role, approvalRequired: true }, loading: false }),
}));
vi.mock("@/components/Toast", () => ({ useToast: (position?: string) => { h.toastPosition(position); return h.toast; } }));
vi.mock("@/components/TrialUrgentBanner", () => ({ TrialUrgentBanner: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }), useParams: () => ({ id: h.id }), usePathname: () => `/templates/${h.id}` }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import TemplateDetailPage from "./page";

const CASE: DesignTemplate = {
  id: "case",
  name: "Case Study",
  pillar: "Promotional",
  category: "Case Study",
  linkUrl: "https://www.figma.com/design/AbC/Case-Study",
  previewUrl: null,
  published: false,
  format: "carousel",
  slides: 5,
  platforms: ["linkedin", "instagram"],
  slideImages: [],
  captionGuideline: null,
  createdAt: "2026-11-12T03:00:00.000Z",
  updatedAt: "2026-11-13T03:00:00.000Z",
  createdBy: "Dewi Kusuma",
};

let list: DesignTemplate[];
beforeEach(() => {
  vi.clearAllMocks();
  h.role = "designer";
  h.id = "case";
  h.usage = { created: 0, inReview: 0 };
  list = [{ ...CASE }];
  h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/templates" && !init) return { templates: list };
    if (path === "/templates/case/usage") return h.usage;
    if (path === "/templates/case/status") {
      const { published } = JSON.parse(init!.body!);
      list = [{ ...list[0], published }];
      return { template: list[0] };
    }
    return { ok: true };
  });
});
afterEach(cleanup);

const statusCalls = () => h.apiFetch.mock.calls.filter(([p]) => p === "/templates/case/status");

describe("Template page: the design team", () => {
  it("says what the template is: pillar, category, format, platforms, link, who made it and when", async () => {
    render(<TemplateDetailPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Case Study" })).toBeTruthy();
    const facts = within(screen.getByText("Content pillar").closest("dl")!);
    expect(facts.getByText("Promotional")).toBeTruthy();
    expect(facts.getByText("Carousel · 5 slides")).toBeTruthy();
    expect(facts.getByText("LinkedIn · Instagram")).toBeTruthy();
    expect(facts.getByText("figma.com/design/AbC/Case-Study").closest("a")!.getAttribute("href")).toBe("https://www.figma.com/design/AbC/Case-Study");
    expect(facts.getByText("Dewi Kusuma · Design team")).toBeTruthy();
    expect(facts.getByText("12 Nov 2026 · 10:00")).toBeTruthy();
    expect(facts.getByText("13 Nov 2026 · 10:00")).toBeTruthy();
  });

  it("a draft says Marketing cannot see it, and offers Publish; Back to library goes to the list", async () => {
    render(<TemplateDetailPage />);
    expect(await screen.findByText("This template is a draft")).toBeTruthy();
    expect(screen.getAllByText("Draft").length).toBeGreaterThan(0);
    expect(screen.getByText("Hidden from Marketing", { selector: "span" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to library" }).getAttribute("href")).toBe("/templates");
  });

  it("asks for its toasts under the header (top right), not in the corner", async () => {
    render(<TemplateDetailPage />);
    await screen.findByRole("heading", { level: 1, name: "Case Study" });
    expect(h.toastPosition).toHaveBeenCalledWith("top-right");
    expect(h.toastPosition).not.toHaveBeenCalledWith(undefined);
  });

  it("Publish sends published: true at once (no dialog), says Marketing can see it, and then offers Unpublish", async () => {
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    expect(statusCalls()[0][1]).toEqual({ method: "PATCH", body: JSON.stringify({ published: true }) });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Case Study published. Marketing can see it now."));
    expect(await screen.findByRole("button", { name: "Unpublish" })).toBeTruthy();
    expect(screen.queryByText("This template is a draft")).toBeNull();
  });

  describe("Unpublish asks first", () => {
    beforeEach(() => {
      list = [{ ...CASE, published: true }];
    });
    const dialog = async () => screen.findByRole("alertdialog", { name: "Unpublish Case Study?" });

    it("nothing is sent until it is confirmed; Cancel changes nothing", async () => {
      render(<TemplateDetailPage />);
      await userEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
      const d = await dialog();
      expect(within(d).getByText(/goes back to Draft and disappears from Marketing/)).toBeTruthy();
      expect(within(d).getByText("Draft · hidden from Marketing")).toBeTruthy();
      expect(statusCalls()).toHaveLength(0);
      await userEvent.click(within(d).getByRole("button", { name: "Cancel" }));
      expect(statusCalls()).toHaveLength(0);
      expect(h.toast.success).not.toHaveBeenCalled();
    });

    it("Unpublish template sends published: false, says so in a toast, and the page shows a draft", async () => {
      render(<TemplateDetailPage />);
      await userEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
      await userEvent.click(within(await dialog()).getByRole("button", { name: "Unpublish template" }));
      await waitFor(() => expect(statusCalls()[0][1]).toEqual({ method: "PATCH", body: JSON.stringify({ published: false }) }));
      // it took the template away from Marketing: a red toast, not the green one of "published"
      await waitFor(() => expect(h.toast.danger).toHaveBeenCalledWith("Case Study unpublished. Marketing no longer sees it."));
      expect(h.toast.success).not.toHaveBeenCalled();
      expect(await screen.findByRole("button", { name: "Publish" })).toBeTruthy();
    });

    it("says how many posts in review are of the category, and only when there are some", async () => {
      h.usage = { created: 12, inReview: 3 };
      render(<TemplateDetailPage />);
      await userEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
      const note = await within(await dialog()).findByRole("note");
      expect(note.textContent).toContain("3 posts in review use this template");
      expect(note.textContent).toContain("They keep the current design");
    });

    it("one post reads in the singular", async () => {
      h.usage = { created: 1, inReview: 1 };
      render(<TemplateDetailPage />);
      await userEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
      expect((await within(await dialog()).findByRole("note")).textContent).toContain("1 post in review uses this template");
    });

    it("no post in review: no warning box", async () => {
      h.usage = { created: 12, inReview: 0 };
      render(<TemplateDetailPage />);
      await userEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
      const d = await dialog();
      await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith("/templates/case/usage"));
      expect(within(d).queryByRole("note")).toBeNull();
    });

    it("when the counts cannot be loaded the dialog still works and says nothing it does not know", async () => {
      h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
        if (path === "/templates") return { templates: list };
        if (path === "/templates/case/usage") throw new Error("boom");
        return { template: list[0], init };
      });
      render(<TemplateDetailPage />);
      await userEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
      const d = await dialog();
      expect(within(d).queryByRole("note")).toBeNull();
      expect(within(d).getByRole("button", { name: "Unpublish template" })).toBeTruthy();
    });

    it("a refusal is told in a toast and the dialog stays for another try", async () => {
      h.apiFetch.mockImplementation(async (path: string) => {
        if (path === "/templates") return { templates: list };
        if (path === "/templates/case/usage") return h.usage;
        throw new Error("Templates are managed by the design team only.");
      });
      render(<TemplateDetailPage />);
      await userEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
      await userEvent.click(within(await dialog()).getByRole("button", { name: "Unpublish template" }));
      await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Templates are managed by the design team only."));
      expect(await dialog()).toBeTruthy();
    });
  });

  it("a status change that fails says why and changes nothing on the page", async () => {
    h.apiFetch.mockImplementation(async (path: string, init?: unknown) => {
      if (path === "/templates/case/status") throw new Error("Templates are managed by the design team only.");
      return init ? { ok: true } : { templates: list };
    });
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Templates are managed by the design team only."));
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
  });

  it("Edit template opens the editor with this template", async () => {
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit template" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit template" });
    expect((within(dialog).getByLabelText(/^Slides/) as HTMLInputElement).value).toBe("5");
  });

  it("Delete asks first; confirming deletes it, says so in a toast and goes back to the list", async () => {
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Case Study?" });
    expect(within(dialog).getByText(/permanently removes the template, its preview and its Figma link from Postly/)).toBeTruthy();
    expect(within(dialog).getByText("Dewi K. · 12 Nov 2026")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(h.apiFetch.mock.calls.filter(([, i]) => i?.method === "DELETE")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete template" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith("/templates/case", { method: "DELETE" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/templates"));
    expect(h.toast.danger).toHaveBeenCalledWith("Case Study template deleted.");
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it("the Delete dialog says how many posts are of the category, and offers Unpublish instead for a published template", async () => {
    list = [{ ...CASE, published: true }];
    h.usage = { created: 12, inReview: 3 };
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const note = await within(await screen.findByRole("alertdialog")).findByRole("note");
    expect(note.textContent).toContain("12 posts are of this category");
    expect(note.textContent).toContain("Unpublish instead if you might need it later.");
  });

  it("a draft's Delete dialog has no 'Unpublish instead', and no box without posts", async () => {
    h.usage = { created: 2, inReview: 0 };
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const note = await within(await screen.findByRole("alertdialog")).findByRole("note");
    expect(note.textContent).toContain("2 posts are of this category");
    expect(note.textContent).not.toContain("Unpublish instead");

    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    h.usage = { created: 0, inReview: 0 };
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const again = await screen.findByRole("alertdialog");
    await waitFor(() => expect(within(again).queryByRole("note")).toBeNull());
  });

  it("a delete that fails is told in a toast and the dialog stays", async () => {
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") throw new Error("Not found");
      if (path === "/templates/case/usage") return h.usage;
      return { templates: list };
    });
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete template" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Not found"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(h.push).not.toHaveBeenCalled();
  });

  // The closing frame of the dialogs is tested in components/templates/TemplateDialogs.test.tsx (jsdom has no fade-out).
  describe("the red box of a dialog", () => {
    it("the red box has its place from the first frame: it is in the page with no height until there is a count (nothing jumps in)", async () => {
      list = [{ ...CASE, published: true }];
      h.usage = { created: 0, inReview: 0 };
      render(<TemplateDetailPage />);
      await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
      const d = await screen.findByRole("alertdialog", { name: "Delete Case Study?" });
      await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith("/templates/case/usage"));
      expect(within(d).queryByRole("note")).toBeNull();
      // the row that holds the box is closed (0fr), so a box that arrives later opens it instead of pushing the dialog
      expect(d.querySelector(".grid-rows-\\[0fr\\]")).not.toBeNull();
    });
  });

  // A dangerous action is red from the button that asks to the button that confirms, so nobody meets it half-warned.
  describe("every dangerous action is red", () => {
    const red = (el: Element) => expect(el.className).toContain("text-red-600");

    it("Delete and Unpublish are red outlines in the bar; Edit template is the yellow one", async () => {
      list = [{ ...CASE, published: true }];
      render(<TemplateDetailPage />);
      const del = await screen.findByRole("button", { name: "Delete" });
      const unpublish = screen.getByRole("button", { name: "Unpublish" });
      for (const b of [del, unpublish]) {
        red(b);
        expect(b.className).toContain("border-red-200");
      }
      expect(screen.getByRole("button", { name: "Edit template" }).className).not.toContain("red");
    });

    it("a draft's bar has a red Delete and a yellow Publish", async () => {
      render(<TemplateDetailPage />);
      red(await screen.findByRole("button", { name: "Delete" }));
      expect(screen.getByRole("button", { name: "Publish" }).className).not.toContain("red");
    });

    it("the Unpublish dialog is red: its icon, its box and its confirm button", async () => {
      list = [{ ...CASE, published: true }];
      h.usage = { created: 12, inReview: 3 };
      render(<TemplateDetailPage />);
      await userEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
      const d = await screen.findByRole("alertdialog", { name: "Unpublish Case Study?" });
      expect(d.querySelector("[data-slot=alert-dialog-media]")!.className).toContain("bg-red-50");
      expect((await within(d).findByRole("note")).className).toContain("bg-red-50");
      expect(within(d).getByRole("button", { name: "Unpublish template" }).className).toContain("bg-destructive");
    });

    it("the Delete dialog is red: its icon, its box and its confirm button", async () => {
      h.usage = { created: 2, inReview: 0 };
      render(<TemplateDetailPage />);
      await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
      const d = await screen.findByRole("alertdialog", { name: "Delete Case Study?" });
      expect(d.querySelector("[data-slot=alert-dialog-media]")!.className).toContain("bg-red-50");
      expect((await within(d).findByRole("note")).className).toContain("bg-red-50");
      expect(within(d).getByRole("button", { name: "Delete template" }).className).toContain("bg-destructive");
    });

    it("Remove link is red, and so is its dialog's confirm button", async () => {
      list = [{ ...CASE, designId: "d1", canvasRevision: 1 }];
      withDesigns([]);
      render(<TemplateDetailPage />);
      const remove = await screen.findByRole("button", { name: /Remove link/ });
      red(remove);
      await userEvent.click(remove);
      const d = await screen.findByRole("alertdialog");
      expect(d.querySelector("[data-slot=alert-dialog-media]")!.className).toContain("bg-red-50");
      expect(within(d).getByRole("button", { name: "Remove link" }).className).toContain("bg-destructive");
    });

    it("what is not dangerous is not red: linking, creating and opening the design", async () => {
      list = [{ ...CASE, designId: "d1", canvasRevision: 1 }];
      withDesigns([]);
      render(<TemplateDetailPage />);
      expect((await screen.findByRole("link", { name: /Open in Canvas/ })).className).not.toContain("red");
    });
  });

  it("a template that is not in the list is 'not found', with a way back", async () => {
    h.id = "gone";
    render(<TemplateDetailPage />);
    expect(await screen.findByText("Template not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to library" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });

  it("while it loads there is a skeleton; when it fails it says so and offers to try again", async () => {
    h.apiFetch.mockRejectedValueOnce(new Error("Network down"));
    render(<TemplateDetailPage />);
    expect(await screen.findByText("We couldn't load the template")).toBeTruthy();
  });
});

describe("Template page: Marketing", () => {
  beforeEach(() => {
    h.role = "member";
    list = [{ ...CASE, published: true }]; // the API sends the published ones only
  });

  it("opens the design and uses the template, and has none of the design team's buttons or the status", async () => {
    render(<TemplateDetailPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Case Study" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in Figma" }).getAttribute("href")).toBe("https://www.figma.com/design/AbC/Case-Study");
    for (const name of ["Edit template", "Publish", "Unpublish", "Delete"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByText("Published")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Use template" }));
    expect(h.push).toHaveBeenCalledWith("/compose?template=case");
  });

  it("a draft's id is 'not found': Marketing was never sent it", async () => {
    list = [];
    render(<TemplateDetailPage />);
    expect(await screen.findByText("Template not found")).toBeTruthy();
  });

  it("a role that may not make posts has no Use template", async () => {
    h.role = "guest";
    render(<TemplateDetailPage />);
    await screen.findByRole("heading", { level: 1, name: "Case Study" });
    expect(screen.queryByRole("button", { name: "Use template" })).toBeNull();
  });

  // Phase 5: a template made in Canvas can be customized into the person's own design.
  it.each(["member", "admin", "owner"])("%s: a template with a Canvas revision has Customize in Canvas, next to Use template, which is unchanged", async (role) => {
    h.role = role;
    list = [{ ...CASE, published: true, canvasRevision: 2 }];
    render(<TemplateDetailPage />);
    await screen.findByRole("heading", { level: 1, name: "Case Study" });
    expect(screen.getByRole("button", { name: /Customize in Canvas/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use template" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in Figma" })).toBeTruthy(); // a Figma link and a revision: both are offered
  });

  it("a template with no Canvas revision (Figma only) has no Customize button", async () => {
    render(<TemplateDetailPage />); // CASE has no canvasRevision
    await screen.findByRole("heading", { level: 1, name: "Case Study" });
    expect(screen.queryByRole("button", { name: /Customize/ })).toBeNull();
    list = [{ ...CASE, published: true, canvasRevision: null }];
    cleanup();
    render(<TemplateDetailPage />);
    await screen.findByRole("heading", { level: 1, name: "Case Study" });
    expect(screen.queryByRole("button", { name: /Customize/ })).toBeNull();
  });

  it("a role that may not make content has no Customize button, even for a Canvas template", async () => {
    h.role = "guest";
    list = [{ ...CASE, published: true, canvasRevision: 1 }];
    render(<TemplateDetailPage />);
    await screen.findByRole("heading", { level: 1, name: "Case Study" });
    expect(screen.queryByRole("button", { name: /Customize/ })).toBeNull();
  });

  it("Customize asks the server to make the design from this template (naming only the template) and opens it", async () => {
    list = [{ ...CASE, published: true, canvasRevision: 2 }];
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/templates" && !init) return { templates: list };
      if (path === "/canvas/instances") return { instance: { id: "inst-9", name: "Case Study", version: 1, createdAt: "2026-11-18T00:00:00Z", baseRevision: { number: 2, createdAt: "2026-11-18T00:00:00Z" } } };
      return { ok: true };
    });
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Customize in Canvas/ }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/canvas/inst-9"));
    const call = h.apiFetch.mock.calls.find(([p]) => p === "/canvas/instances")!;
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({ templateId: "case" }); // never a revision, a kind or an owner
  });

  it("when the server refuses (the template was unpublished a moment ago), its message is shown and nothing opens", async () => {
    list = [{ ...CASE, published: true, canvasRevision: 2 }];
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/templates" && !init) return { templates: list };
      if (path === "/canvas/instances") throw Object.assign(new Error("Template not found"), { status: 404 });
      return { ok: true };
    });
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Customize in Canvas/ }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Template not found"));
    expect(h.push).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /Customize in Canvas/ }) as HTMLButtonElement).disabled).toBe(false); // try again is possible
  });
});

describe("Template page: slides, caption guideline and checklist", () => {
  const WITH = {
    published: true,
    format: "carousel" as const,
    slides: 3,
    slideImages: [{ url: "/uploads/a.png", label: "Cover" }, { url: "/uploads/b.png", label: null }, { url: "/uploads/c.png", label: "Call to action" }],
    captionGuideline: "Open with the problem.\nKeep it under 300 characters.\n#GeospatialIndonesia #BragaGeo",
    previewUrl: "/uploads/p.png",
  };

  it("shows each slide with its name under it, and 'Slide N' for one with none", async () => {
    list = [{ ...CASE, ...WITH }];
    render(<TemplateDetailPage />);
    const slides = within(await screen.findByRole("region", { name: "Slides in this template" }));
    expect(slides.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1 · Cover", "2 · Slide 2", "3 · Call to action"]);
    expect(slides.getAllByRole("img").map((i) => i.getAttribute("src"))).toEqual(["http://localhost:3001/uploads/a.png", "http://localhost:3001/uploads/b.png", "http://localhost:3001/uploads/c.png"]);
  });

  it("a template with no slides draws no Slides card, and no empty Caption card", async () => {
    render(<TemplateDetailPage />);
    await screen.findByRole("heading", { level: 1, name: "Case Study" });
    expect(screen.queryByRole("region", { name: "Slides in this template" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Caption guideline" })).toBeNull();
  });

  it("shows the caption guideline with its line breaks, and the hashtags set apart", async () => {
    list = [{ ...CASE, ...WITH }];
    render(<TemplateDetailPage />);
    const card = within(await screen.findByRole("region", { name: "Caption guideline" }));
    expect(card.getByText(/Open with the problem\./).textContent).toContain("Keep it under 300 characters.");
    expect(card.getByText("#GeospatialIndonesia").className).toContain("text-brand-800");
    expect(card.getByText("#BragaGeo").className).toContain("text-brand-800");
    expect(card.getByText(/Open with the problem\./).className).toContain("whitespace-pre-line");
  });

  it("the mockup pages through the slides, one at a time", async () => {
    list = [{ ...CASE, ...WITH }];
    render(<TemplateDetailPage />);
    const mock = within(await screen.findByRole("figure", { name: /post preview/ }));
    expect(mock.getByText("1 / 3")).toBeTruthy();
    expect((mock.getByRole("button", { name: "Previous slide" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(mock.getByRole("button", { name: "Next slide" }));
    expect(mock.getByText("2 / 3")).toBeTruthy();
    expect(mock.getByRole("img", { name: /slide 2 of 3/ }).getAttribute("src")).toContain("/uploads/b.png");
    await userEvent.click(mock.getByRole("button", { name: "Next slide" }));
    expect((mock.getByRole("button", { name: "Next slide" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the mockup is for the template's platforms: a tab each, the first one chosen", async () => {
    list = [{ ...CASE, ...WITH, platforms: ["linkedin", "instagram"] }];
    render(<TemplateDetailPage />);
    const group = within(await screen.findByRole("group", { name: "Preview as" }));
    expect(group.getByRole("button", { name: "LinkedIn" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(group.getByRole("button", { name: "Instagram" }));
    expect(screen.getByRole("figure", { name: "Instagram post preview" })).toBeTruthy();
  });

  it("a template with no picture says there is no preview yet, instead of showing an empty frame", async () => {
    render(<TemplateDetailPage />);
    expect(await screen.findByText("No preview image yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next slide" })).toBeNull();
  });

  it("the checklist counts what the template has, from its data", async () => {
    list = [{ ...CASE, ...WITH }];
    render(<TemplateDetailPage />);
    const card = within(await screen.findByRole("region", { name: "Template checklist" }));
    expect(card.getByText("5 of 5 ready")).toBeTruthy();
    expect(card.getByText("Edits to a published template reach Marketing immediately. Unpublish first if you need a larger rework.")).toBeTruthy();
  });

  it("and says what is missing", async () => {
    list = [{ ...CASE, linkUrl: null, format: null, platforms: [] }];
    render(<TemplateDetailPage />);
    const card = within(await screen.findByRole("region", { name: "Template checklist" }));
    expect(card.getByText("0 of 4 ready")).toBeTruthy();
    expect(card.getByText("Upload a preview image or the slides")).toBeTruthy();
    expect(card.getByText("Choose a content format")).toBeTruthy();
    expect(card.getAllByText(/not ready/)).toHaveLength(4);
  });
});

describe("Template page: what Marketing sees", () => {
  beforeEach(() => {
    h.role = "member";
  });
  const full = {
    published: true,
    format: "carousel" as const,
    slideImages: [{ url: "/uploads/a.png", label: "Cover" }, { url: "/uploads/b.png", label: null }],
    captionGuideline: "Be brief. #BragaGeo",
  };

  it("the same layout: the design, its slides and the caption guideline; no status, no checklist, no Canvas block", async () => {
    list = [{ ...CASE, ...full }];
    render(<TemplateDetailPage />);
    await screen.findByRole("heading", { level: 1, name: "Case Study" });
    expect(screen.getByRole("region", { name: "Slides in this template" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Caption guideline" })).toBeTruthy();
    expect(screen.getByRole("figure", { name: /post preview/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Template checklist" })).toBeNull();
    expect(screen.queryByText("Visible to Marketing")).toBeNull();
    expect(screen.queryByText("Hidden from Marketing")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to library" })).toBeTruthy();
  });

  it("never asks for the usage counts (the design team's dialogs are the only readers)", async () => {
    list = [{ ...CASE, ...full }];
    render(<TemplateDetailPage />);
    await screen.findByRole("heading", { level: 1, name: "Case Study" });
    expect(h.apiFetch.mock.calls.filter(([p]) => String(p).endsWith("/usage"))).toHaveLength(0);
  });
});

// ── Canvas designs (phase 4) ───────────────────────────────────────────────────────────────────────────────────

const DESIGN_ROW = { updatedAt: "2026-11-14T00:00:00Z", version: 1 };
/** The API as the page sees it: the template list, and the designer's Canvas designs. */
const withDesigns = (designs: unknown[], answer: unknown = { designId: "d1" }) =>
  h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/templates" && !init) return { templates: list };
    if (path === "/canvas/designs") return { designs };
    return answer;
  });

describe("Template page: the Canvas design of a template (the design team)", () => {
  const publishButton = () => screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;

  it("a draft with no source cannot be published: the button is off and says what to add", async () => {
    list = [{ ...CASE, linkUrl: null }];
    render(<TemplateDetailPage />);
    await screen.findByText("This template is a draft");
    expect(publishButton().disabled).toBe(true);
    expect(publishButton().getAttribute("title")).toBe("Add a Figma link or publish a Canvas revision first.");
    // Also as visible text, tied to the button: a disabled button takes no focus and a tooltip does not show on touch.
    expect(document.getElementById("publish-reason")!.textContent).toBe("Add a Figma link or publish a Canvas revision first.");
    expect(publishButton().getAttribute("aria-describedby")).toBe("publish-reason");
    expect(screen.getByText("No Figma link yet")).toBeTruthy();
  });

  it("a draft that can be published shows no reason", async () => {
    render(<TemplateDetailPage />);
    await screen.findByText("This template is a draft");
    expect(document.getElementById("publish-reason")).toBeNull();
    expect(publishButton().getAttribute("aria-describedby")).toBeNull();
  });

  it.each([["only spaces", "   "], ["not a Figma design", "https://example.com"]])("a link that is %s is not a source: Publish stays off, and the page never calls it a Figma link", async (_label, linkUrl) => {
    list = [{ ...CASE, linkUrl }];
    render(<TemplateDetailPage />);
    await screen.findByText("This template is a draft");
    expect(publishButton().disabled).toBe(true);
    expect(screen.queryByRole("link", { name: /figma/i })).toBeNull();
  });

  it("a template with a valid Figma link can still be published, as before", async () => {
    render(<TemplateDetailPage />);
    await screen.findByText("This template is a draft");
    expect(publishButton().disabled).toBe(false);
  });

  it("a Canvas-native template (no link, a design with a revision) can be published, and says which revision it is", async () => {
    list = [{ ...CASE, linkUrl: null, designId: "d1", canvasRevision: 2 }];
    withDesigns([{ id: "d1", name: "Case design", ...DESIGN_ROW, template: { id: "case", category: "Case Study", published: false }, latestRevision: { number: 2, designVersion: 4, createdAt: "2026-11-14T00:00:00Z" } }]);
    render(<TemplateDetailPage />);
    await screen.findByText("This template is a draft");
    expect(publishButton().disabled).toBe(false);
    expect(await screen.findByText(/Case design/)).toBeTruthy();
    expect(screen.getAllByText(/Revision 2/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /Open in Canvas/ }).getAttribute("href")).toBe("/canvas/d1");
  });

  it("a linked design with no revision says so, and does not make the template publishable", async () => {
    list = [{ ...CASE, linkUrl: null, designId: "d1", canvasRevision: null }];
    withDesigns([]);
    render(<TemplateDetailPage />);
    await screen.findByText("This template is a draft");
    expect(publishButton().disabled).toBe(true);
    expect(screen.getAllByText(/no revision yet/i).length).toBeGreaterThan(0);
  });

  it("shows the Canvas block to the design team, with Create and Link when there is no design", async () => {
    render(<TemplateDetailPage />);
    expect(await screen.findByRole("heading", { name: "Canvas design" })).toBeTruthy();
    expect((screen.getByRole("button", { name: /Create Canvas design/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: /Link existing design/ })).toBeTruthy();
  });

  it("Create Canvas design is ONE request to the server (which makes and links the design), then opens the design", async () => {
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/templates" && !init) return { templates: list };
      if (path === "/canvas/templates/case/design") return { design: { id: "new-design", name: "Case Study", version: 1 } };
      return { ok: true };
    });
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Create Canvas design/ }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/canvas/new-design"));
    const canvasCalls = h.apiFetch.mock.calls.filter(([p]) => String(p).startsWith("/canvas/"));
    expect(canvasCalls).toEqual([["/canvas/templates/case/design", { method: "POST", body: "{}" }]]); // no separate create, no separate attach
  });

  it("when the server refuses, nothing is created or opened, the person is told, and the page reloads what the server has", async () => {
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/templates" && !init) return { templates: list };
      if (path === "/canvas/templates/case/design") throw new Error("This template already has a Canvas design. Remove it first to attach another.");
      return { ok: true };
    });
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Create Canvas design/ }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("This template already has a Canvas design. Remove it first to attach another."));
    expect(h.push).not.toHaveBeenCalled();
    expect(h.apiFetch.mock.calls.filter(([p]) => p === "/canvas/designs")).toHaveLength(0); // never a separate design creation that could be left behind
    expect(h.apiFetch.mock.calls.filter(([p, i]) => p === "/templates" && !i).length).toBeGreaterThan(1); // reloaded
    expect((screen.getByRole("button", { name: /Create Canvas design/ }) as HTMLButtonElement).disabled).toBe(false); // can try again
  });

  it("a server fault or a busy server is told in a plain sentence, never as the server's class name", async () => {
    for (const [status, shown] of [
      [500, "Posthive had a problem on its side. Try again in a moment."],
      [503, "Posthive is busy right now. Try again in a moment."],
    ] as const) {
      h.toast.error.mockClear();
      h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
        if (path === "/templates" && !init) return { templates: list };
        if (path === "/canvas/templates/case/design") throw Object.assign(new Error("PrismaClientInitializationError"), { status });
        return { ok: true };
      });
      const view = render(<TemplateDetailPage />);
      await userEvent.click(await screen.findByRole("button", { name: /Create Canvas design/ }));
      await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith(shown));
      expect(h.toast.error).not.toHaveBeenCalledWith("PrismaClientInitializationError");
      view.unmount();
    }
  });

  it("Create Canvas design is off for a published template that has no source, and says why", async () => {
    list = [{ ...CASE, linkUrl: null, published: true }];
    render(<TemplateDetailPage />);
    await screen.findByRole("heading", { name: "Canvas design" });
    expect((screen.getByRole("button", { name: /Create Canvas design/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("published and has no source yet");
  });

  it("the linking list enables only designs that have a revision when the template is published with no source", async () => {
    list = [{ ...CASE, linkUrl: null, published: true }];
    withDesigns([
      { id: "bare", name: "No revision", ...DESIGN_ROW, template: null, latestRevision: null },
      { id: "ready", name: "Has revision", ...DESIGN_ROW, template: null, latestRevision: { number: 1, designVersion: 2, createdAt: "2026-11-14T00:00:00Z" } },
      { id: "taken", name: "Used elsewhere", ...DESIGN_ROW, template: { id: "other", category: "Blog Post", published: false }, latestRevision: null },
    ]);
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Link existing design/ }));
    const group = await screen.findByRole("group", { name: "Choose a design to link" });
    expect(within(group).queryByText(/Used elsewhere/)).toBeNull(); // already attached to another template
    const links = within(group).getAllByRole("button", { name: "Link" }) as HTMLButtonElement[];
    expect(links).toHaveLength(2);
    expect(links[0].disabled).toBe(true); // no revision
    expect(links[1].disabled).toBe(false); // has a revision
    expect(within(group).getByText(/no longer returned by the public API and MCP/)).toBeTruthy();
  });

  it("linking a design sends the template's and the design's ids to the API", async () => {
    withDesigns([{ id: "d1", name: "Mine", ...DESIGN_ROW, template: null, latestRevision: null }]);
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Link existing design/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Link" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith("/canvas/templates/case/design", { method: "PUT", body: JSON.stringify({ designId: "d1" }) }));
  });

  it("a refusal from the API is shown, and the template is not changed", async () => {
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/templates" && !init) return { templates: list };
      if (path === "/canvas/designs") return { designs: [{ id: "d1", name: "Mine", ...DESIGN_ROW, template: null, latestRevision: null }] };
      throw new Error("This design is already attached to a template.");
    });
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Link existing design/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Link" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("This design is already attached to a template."));
  });

  it("Remove link asks first and then unlinks, keeping the design", async () => {
    list = [{ ...CASE, designId: "d1", canvasRevision: 1 }];
    withDesigns([]);
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Remove link/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("kept in your Canvas designs");
    expect(h.apiFetch.mock.calls.filter(([, i]) => i?.method === "DELETE")).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith("/canvas/templates/case/design", { method: "DELETE" }));
    await waitFor(() => expect(h.toast.danger).toHaveBeenCalledWith("The Canvas design was unlinked. It is still in your Canvas designs."));
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it("Marketing sees no Canvas block, no Create, no Link and no Remove", async () => {
    h.role = "member";
    list = [{ ...CASE, published: true, designId: "d1", canvasRevision: 1 }];
    render(<TemplateDetailPage />);
    await screen.findByRole("heading", { level: 1, name: "Case Study" });
    expect(screen.queryByRole("heading", { name: "Canvas design" })).toBeNull();
    for (const name of [/Create Canvas design/, /Link existing design/, /Remove link/]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("link", { name: /Open in Canvas/ })).toBeNull();
  });
});
