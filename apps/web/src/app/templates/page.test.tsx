// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesignTemplate } from "@/lib/templates";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  push: vi.fn(),
  role: "designer" as string,
  toast: { toast: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  csv: vi.fn(),
  // what the page asked useToast for
  toastPosition: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { name: "Dewi Kusuma", role: h.role } }) }));
vi.mock("@/context/WorkspaceContext", () => ({
  useWorkspace: () => ({ activeWorkspace: { id: "ws-1", name: "Braga Tech", role: h.role, approvalRequired: true }, loading: false }),
}));
vi.mock("@/components/Toast", () => ({ useToast: (position?: string) => { h.toastPosition(position); return h.toast; } }));
vi.mock("@/components/TrialUrgentBanner", () => ({ TrialUrgentBanner: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }), usePathname: () => "/templates" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/lib/template-library", async (orig) => ({ ...(await orig<typeof import("@/lib/template-library")>()), downloadCsv: h.csv }));

import TemplatesPage from "./page";

const make = (i: number, patch: Partial<DesignTemplate> = {}): DesignTemplate => ({
  id: `t${i}`,
  name: `Category ${i}`,
  pillar: "Promotional",
  category: "Case Study",
  linkUrl: `https://www.figma.com/design/AbC/File-${i}`,
  previewUrl: null,
  published: true,
  format: "carousel",
  slides: 5,
  platforms: ["linkedin", "instagram"],
  slideImages: [],
  captionGuideline: null,
  createdAt: `2026-11-${String(30 - i).padStart(2, "0")}T03:00:00.000Z`,
  createdBy: "Dewi Kusuma",
  ...patch,
});

// Three that exist for real; the rest are only here to fill a second page
const CASE = make(1, { id: "case", category: "Case Study", published: true });
const BLOG = make(2, { id: "blog", category: "Blog Post", pillar: "Educational", format: "single", slides: null, platforms: ["instagram"], published: false });
const AMA = make(3, { id: "ama", category: "Ask Me Anything", pillar: null, format: null, slides: null, platforms: [], linkUrl: null, published: true });

let list: DesignTemplate[];
const serve = () =>
  h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/templates" && !init) return { templates: list };
    return { ok: true };
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "designer";
  list = [CASE, BLOG, AMA];
  serve();
});
afterEach(cleanup);

const cards = () => {
  const list = screen.queryByRole("list", { name: "Templates" });
  return list ? within(list).queryAllByRole("listitem") : [];
};
const titles = () => cards().map((c) => within(c).getAllByRole("heading", { level: 3 })[0].textContent);

describe("Template Library: the design team", () => {
  it("is Master Template, with a card for every template, drafts included, newest first", async () => {
    render(<TemplatesPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Master Template" })).toBeTruthy();
    await screen.findByText("Case Study", { selector: "h3" });
    expect(titles()).toEqual(["Case Study", "Blog Post", "Ask Me Anything"]);
    expect(screen.getByText("Design workspace")).toBeTruthy();
  });

  it("a card says its status, pillar and format, platforms, link and who made it", async () => {
    render(<TemplatesPage />);
    const card = within((await screen.findByText("Case Study", { selector: "h3" })).closest("li")!);
    expect(card.getByText("Published")).toBeTruthy();
    expect(card.getByText("Promotional · Carousel · 5 slides")).toBeTruthy();
    expect(card.getByText("LinkedIn · Instagram")).toBeTruthy();
    expect(card.getByText("figma.com/design/AbC/File-1")).toBeTruthy();
    expect(card.getByText("Created 29 Nov 2026 · Dewi K.")).toBeTruthy();
    const blog = within(screen.getByText("Blog Post", { selector: "h3" }).closest("li")!);
    expect(blog.getByText("Draft")).toBeTruthy();
  });

  it("what is missing says so instead of leaving a gap", async () => {
    render(<TemplatesPage />);
    const ama = within((await screen.findByText("Ask Me Anything", { selector: "h3" })).closest("li")!);
    expect(ama.getByText("No pillar · No format yet")).toBeTruthy();
    expect(ama.getByText("No platform yet")).toBeTruthy();
    expect(ama.getByText("No Figma link yet")).toBeTruthy();
  });

  it("the four cards count them: total, published, draft and the pillars Marketing has", async () => {
    render(<TemplatesPage />);
    await screen.findByText("Case Study", { selector: "h3" });
    const stat = (label: string) => screen.getByRole("heading", { name: label }).closest("[data-slot=card]") as HTMLElement;
    expect(stat("Total templates").textContent).toContain("3");
    expect(stat("Published · visible to Marketing").textContent).toContain("2");
    expect(stat("Draft · hidden from Marketing").textContent).toContain("1");
    expect(stat("Content pillars covered").textContent).toContain("1");
  });

  it("the notice says what publishing does, and the bottom card what Marketing sees", async () => {
    render(<TemplatesPage />);
    expect(await screen.findByText("Published templates are shared with the Marketing Team")).toBeTruthy();
    expect(screen.getByText("Marketing currently sees 2 published templates across 1 content pillar.")).toBeTruthy();
  });

  it("the tabs show the counts and filter by status; the status filter says the same", async () => {
    render(<TemplatesPage />);
    await screen.findByText("Case Study", { selector: "h3" });
    const tabs = within(screen.getByRole("tablist", { name: "Template status" }));
    expect(tabs.getByRole("tab", { name: /All templates\s*3/ })).toBeTruthy();
    await userEvent.click(tabs.getByRole("tab", { name: /Draft\s*1/ }));
    expect(titles()).toEqual(["Blog Post"]);
    expect(screen.getByText("Showing 1 of 1 template · Drafts are visible to Designers only")).toBeTruthy();
    await userEvent.click(tabs.getByRole("tab", { name: /Published\s*2/ }));
    expect(titles()).toEqual(["Case Study", "Ask Me Anything"]);
  });

  it("search narrows the list, and a search with no match offers to clear the filters", async () => {
    render(<TemplatesPage />);
    await screen.findByText("Case Study", { selector: "h3" });
    await userEvent.type(screen.getByPlaceholderText("Search templates…"), "blog");
    expect(titles()).toEqual(["Blog Post"]);
    await userEvent.clear(screen.getByPlaceholderText("Search templates…"));
    await userEvent.type(screen.getByPlaceholderText("Search templates…"), "zzz");
    expect(await screen.findByText("No templates match")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(titles()).toEqual(["Case Study", "Blog Post", "Ask Me Anything"]);
  });

  it("eight to a page, with a pager", async () => {
    list = Array.from({ length: 11 }, (_, i) => make(i + 1, { id: `m${i}`, category: "Case Study" }));
    render(<TemplatesPage />);
    await screen.findByRole("list", { name: "Templates" });
    expect(cards()).toHaveLength(8);
    expect(screen.getByText("Showing 8 of 11 templates · Drafts are visible to Designers only")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(cards()).toHaveLength(3);
  });

  it("Upload Template opens the editor, and what it saves is a draft: the list is asked again", async () => {
    render(<TemplatesPage />);
    await screen.findByText("Case Study", { selector: "h3" });
    await userEvent.click(screen.getByRole("button", { name: "Upload Template" }));
    expect(await screen.findByRole("dialog", { name: "Upload template" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as draft" })).toBeTruthy();
  });

  it("asks for its toasts under the header (top right), not in the corner", async () => {
    render(<TemplatesPage />);
    await screen.findByText("Case Study", { selector: "h3" });
    expect(h.toastPosition).toHaveBeenCalledWith("top-right");
    expect(h.toastPosition).not.toHaveBeenCalledWith(undefined);
  });

  it("View detail opens the template's own page", async () => {
    render(<TemplatesPage />);
    const link = await screen.findByRole("link", { name: "View detail of Blog Post" });
    expect(link.getAttribute("href")).toBe("/templates/blog");
  });

  it("Delete asks first; Cancel deletes nothing, Delete template does, and the list is asked again", async () => {
    render(<TemplatesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Blog Post" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(h.apiFetch.mock.calls.filter(([, i]) => i?.method === "DELETE")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Delete Blog Post" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete template" }));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith("/templates/blog", { method: "DELETE" }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Blog Post template deleted."));
    await waitFor(() => expect(h.apiFetch.mock.calls.filter(([p, i]) => p === "/templates" && !i)).toHaveLength(2));
  });

  it("a delete that fails says why and keeps the dialog for another try", async () => {
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") throw new Error("Not found");
      return { templates: list };
    });
    render(<TemplatesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Blog Post" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete template" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Not found"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("Export list saves the list as it is filtered, not all of it", async () => {
    render(<TemplatesPage />);
    await screen.findByText("Case Study", { selector: "h3" });
    await userEvent.click(within(screen.getByRole("tablist", { name: "Template status" })).getByRole("tab", { name: /Draft/ }));
    await userEvent.click(screen.getByRole("button", { name: "Export list" }));
    expect(h.csv).toHaveBeenCalledTimes(1);
    const [name, csv] = h.csv.mock.calls[0];
    expect(name).toBe("templates.csv");
    expect(csv).toContain("Blog Post");
    expect(csv).not.toContain("Case Study");
  });

  it("no template yet invites the first upload", async () => {
    list = [];
    render(<TemplatesPage />);
    expect(await screen.findByText("No templates yet")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Upload Template" }).length).toBeGreaterThan(0);
  });

  it("while it loads there is a skeleton; when it fails it says so and offers to try again", async () => {
    h.apiFetch.mockImplementation(() => new Promise(() => {}));
    render(<TemplatesPage />);
    expect(screen.getByLabelText("Loading the templates").getAttribute("aria-busy")).toBe("true");
    cleanup();

    h.apiFetch.mockRejectedValueOnce(new Error("Network down"));
    render(<TemplatesPage />);
    expect(await screen.findByText("We couldn't load the templates")).toBeTruthy();
    serve();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Case Study", { selector: "h3" })).toBeTruthy();
  });
});

describe("Template Library: Marketing", () => {
  beforeEach(() => {
    h.role = "member";
    list = [CASE, AMA]; // the API sends the published ones only
  });

  it("is the Template Library with a card for each published template, and none of the design team's controls", async () => {
    render(<TemplatesPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Template Library" })).toBeTruthy();
    await screen.findByText("Case Study", { selector: "h3" });
    expect(titles()).toEqual(["Case Study", "Ask Me Anything"]);
    expect(screen.getByText("Assets")).toBeTruthy();
    for (const name of ["Upload Template", "Export list"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Template status" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Template status" })).toBeNull();
    expect(screen.queryByText("Published templates are shared with the Marketing Team")).toBeNull();
    expect(screen.queryByText("Total templates")).toBeNull();
    expect(screen.queryByText(/Drafts are visible/)).toBeNull();
  });

  it("each card can be opened and used: Use template goes to Compose with that template", async () => {
    render(<TemplatesPage />);
    expect((await screen.findByRole("link", { name: "View detail of Case Study" })).getAttribute("href")).toBe("/templates/case");
    await userEvent.click(screen.getByRole("button", { name: "Use the Case Study template" }));
    expect(h.push).toHaveBeenCalledWith("/compose?template=case");
  });

  it("the filters are the ones that make sense for Marketing: pillar, format and platform", async () => {
    render(<TemplatesPage />);
    await screen.findByText("Case Study", { selector: "h3" });
    for (const name of ["Content pillar", "Content format", "Publishing platform"]) expect(screen.getByRole("combobox", { name })).toBeTruthy();
  });

  it("nothing published yet says so, without an Upload button", async () => {
    list = [];
    render(<TemplatesPage />);
    expect(await screen.findByText("No published templates yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload Template" })).toBeNull();
  });

  it("a person who may not make posts (the design team's reader roles) gets no Use template", async () => {
    h.role = "guest";
    render(<TemplatesPage />);
    await screen.findByText("Case Study", { selector: "h3" });
    expect(screen.queryByRole("button", { name: /^Use the / })).toBeNull();
  });
});

// ── Canvas designs (phase 4): what a card says about where a template's design lives ────────────────────────────

describe("Template Library: a card says where the design lives", () => {
  const cardOf = async (category: string) => within((await screen.findByText(category, { selector: "h3" })).closest("li")!);

  it("a Canvas-native template shows its Canvas design and revision where it used to say 'No Figma link yet'", async () => {
    list = [make(1, { id: "native", category: "Case Study", linkUrl: null, designId: "d1", canvasRevision: 3, published: true })];
    render(<TemplatesPage />);
    const card = await cardOf("Case Study");
    expect(card.getByText("Canvas design · Revision 3")).toBeTruthy();
    expect(card.queryByText("No Figma link yet")).toBeNull();
  });

  it("a linked design with no revision yet says so", async () => {
    list = [make(1, { id: "bare", category: "Case Study", linkUrl: null, designId: "d1", canvasRevision: null, published: false })];
    render(<TemplatesPage />);
    expect((await cardOf("Case Study")).getByText("Canvas design · no revision yet")).toBeTruthy();
  });

  it("a link that is not a Figma design is not shown as a Figma link", async () => {
    list = [make(1, { id: "odd", category: "Case Study", linkUrl: "https://example.com/file", published: true })];
    render(<TemplatesPage />);
    const card = await cardOf("Case Study");
    expect(card.getByText("Not a Figma link")).toBeTruthy();
    expect(card.queryByText(/figma\.com/i)).toBeNull(); // no shortened Figma address is shown for it
    expect(card.queryByText("example.com/file")).toBeNull(); // and the stored value stays in the tooltip, not the label
  });

  it("a Figma-backed card is unchanged, whether or not it also has a Canvas design", async () => {
    list = [make(1, { id: "both", category: "Case Study", designId: "d1", canvasRevision: 2, published: true })];
    render(<TemplatesPage />);
    expect((await cardOf("Case Study")).getByText("figma.com/design/AbC/File-1")).toBeTruthy();
  });

  it("Marketing sees the same label on a published Canvas-native template, and no way to change it", async () => {
    h.role = "member";
    list = [make(1, { id: "native", category: "Case Study", linkUrl: null, designId: "d1", canvasRevision: 1, published: true })];
    render(<TemplatesPage />);
    const card = await cardOf("Case Study");
    expect(card.getByText("Canvas design · Revision 1")).toBeTruthy();
    expect(card.queryByRole("button", { name: /Delete/ })).toBeNull();
  });
});

// ── Canvas designs (phase 5): Marketing can customize a template that is made in Canvas ─────────────────────────

describe("Template Library: Customize in Canvas", () => {
  const cardOf = async (category: string) => within((await screen.findByText(category, { selector: "h3" })).closest("li")!);

  it.each(["member", "admin", "owner"])("%s: a published template with a Canvas revision has a Customize button on its card, and Use template is unchanged", async (role) => {
    h.role = role;
    list = [make(1, { id: "native", category: "Case Study", linkUrl: null, designId: undefined, canvasRevision: 2, published: true })];
    render(<TemplatesPage />);
    const card = await cardOf("Case Study");
    expect(card.getByRole("button", { name: /Customize in Canvas: Case Study/ })).toBeTruthy();
    expect(card.getByRole("button", { name: "Use the Case Study template" })).toBeTruthy();
  });

  it("a Figma-only template has no Customize button", async () => {
    h.role = "member";
    list = [make(1, { id: "figma", category: "Case Study", canvasRevision: null, published: true })];
    render(<TemplatesPage />);
    const card = await cardOf("Case Study");
    expect(card.queryByRole("button", { name: /Customize/ })).toBeNull();
    expect(card.getByRole("button", { name: "Use the Case Study template" })).toBeTruthy();
  });

  it("the design team has no Customize button: they make the templates, not designs from them", async () => {
    h.role = "designer";
    list = [make(1, { id: "native", category: "Case Study", linkUrl: null, designId: "d1", canvasRevision: 2, published: true })];
    render(<TemplatesPage />);
    expect((await cardOf("Case Study")).queryByRole("button", { name: /Customize/ })).toBeNull();
  });

  it("a person who may not make content has no Customize button", async () => {
    h.role = "guest";
    list = [make(1, { id: "native", category: "Case Study", linkUrl: null, canvasRevision: 2, published: true })];
    render(<TemplatesPage />);
    expect((await cardOf("Case Study")).queryByRole("button", { name: /Customize/ })).toBeNull();
  });

  it("Customize creates the design from this template (naming only the template) and opens it", async () => {
    h.role = "member";
    list = [make(1, { id: "native", category: "Case Study", linkUrl: null, canvasRevision: 2, published: true })];
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/templates" && !init) return { templates: list };
      if (path === "/canvas/instances") return { instance: { id: "inst-1", name: "Case Study", version: 1, createdAt: "2026-11-18T00:00:00Z", baseRevision: { number: 2, createdAt: "2026-11-18T00:00:00Z" } } };
      return { ok: true };
    });
    render(<TemplatesPage />);
    await userEvent.click((await cardOf("Case Study")).getByRole("button", { name: /Customize in Canvas/ }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/canvas/inst-1"));
    const call = h.apiFetch.mock.calls.find(([p]) => p === "/canvas/instances")!;
    expect(JSON.parse(call[1].body)).toEqual({ templateId: "native" });
  });
});
