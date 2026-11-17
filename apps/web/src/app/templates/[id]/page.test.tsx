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
  toast: { toast: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { name: "Dewi Kusuma", role: h.role } }) }));
vi.mock("@/context/WorkspaceContext", () => ({
  useWorkspace: () => ({ activeWorkspace: { id: "ws-1", name: "Braga Tech", role: h.role, approvalRequired: true }, loading: false }),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => h.toast }));
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
  createdAt: "2026-11-12T03:00:00.000Z",
  updatedAt: "2026-11-13T03:00:00.000Z",
  createdBy: "Dewi Kusuma",
};

let list: DesignTemplate[];
beforeEach(() => {
  vi.clearAllMocks();
  h.role = "designer";
  h.id = "case";
  list = [{ ...CASE }];
  h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/templates" && !init) return { templates: list };
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
    expect(facts.getByText("12 Nov 2026 · Dewi K.")).toBeTruthy();
    expect(facts.getByText("13 Nov 2026")).toBeTruthy();
  });

  it("a draft says Marketing cannot see it, and offers Publish; Back to templates goes to the list", async () => {
    render(<TemplateDetailPage />);
    expect(await screen.findByText("This template is a draft")).toBeTruthy();
    expect(screen.getAllByText("Draft").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to templates" }).getAttribute("href")).toBe("/templates");
  });

  it("Publish sends published: true, says Marketing can see it, and then offers Unpublish", async () => {
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    expect(statusCalls()[0][1]).toEqual({ method: "PATCH", body: JSON.stringify({ published: true }) });
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Published. Marketing can see it now."));
    expect(await screen.findByRole("button", { name: "Unpublish" })).toBeTruthy();
    expect(screen.queryByText("This template is a draft")).toBeNull();
  });

  it("Unpublish takes it back to a draft", async () => {
    list = [{ ...CASE, published: true }];
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
    await waitFor(() => expect(statusCalls()[0][1]).toEqual({ method: "PATCH", body: JSON.stringify({ published: false }) }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Moved to draft. Marketing no longer sees it."));
    expect(await screen.findByRole("button", { name: "Publish" })).toBeTruthy();
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

  it("Edit opens the editor with this template", async () => {
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit template" });
    expect((within(dialog).getByLabelText(/^Slides/) as HTMLInputElement).value).toBe("5");
  });

  it("Delete asks first; confirming deletes it and goes back to the list", async () => {
    render(<TemplateDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(h.apiFetch.mock.calls.filter(([, i]) => i?.method === "DELETE")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete template" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith("/templates/case", { method: "DELETE" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/templates"));
    expect(h.toast.success).toHaveBeenCalledWith("Template for Case Study deleted.");
  });

  it("a template that is not in the list is 'not found', with a way back", async () => {
    h.id = "gone";
    render(<TemplateDetailPage />);
    expect(await screen.findByText("Template not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to templates" })).toBeTruthy();
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
    for (const name of ["Edit", "Publish", "Unpublish", "Delete"]) expect(screen.queryByRole("button", { name })).toBeNull();
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
    expect(screen.getByText("Add a Figma link or publish a Canvas revision first.").id).toBe("publish-reason");
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
