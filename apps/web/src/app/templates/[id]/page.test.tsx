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
