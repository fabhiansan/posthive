// @vitest-environment jsdom
// Marketing's Canvas home: the templates it can customize, and its own designs in pages. The network is the one mocked piece.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  push: vi.fn(),
  toast: { toast: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u, API_BASE: "http://localhost:3001" }));
vi.mock("@/components/Toast", () => ({ useToast: () => h.toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { MarketingHome } from "./MarketingHome";

const design = (i: number, over: Record<string, unknown> = {}) => ({
  id: `i${i}`,
  name: `Design ${i}`,
  version: 1,
  createdAt: "2026-11-18T10:00:00.000Z",
  updatedAt: "2026-11-18T11:00:00.000Z",
  baseRevision: { number: 2 },
  ...over,
});
const template = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  pillar: "Promotional",
  category: id,
  linkUrl: null,
  previewUrl: null,
  published: true,
  format: "single",
  slides: null,
  platforms: [],
  canvasRevision: 2,
  createdAt: "2026-11-12T03:00:00.000Z",
  createdBy: null,
  ...over,
});

let templates: unknown[];
/** Pages of "my designs", served by cursor: "" is the first page. */
let pages: Record<string, { instances: unknown[]; nextCursor: string | null }>;
let failCursor: string | null;

beforeEach(() => {
  vi.clearAllMocks();
  templates = [template("Case Study")];
  pages = { "": { instances: [design(3), design(2), design(1)], nextCursor: null } };
  failCursor = null;
  h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/templates") return { templates };
    if (path.startsWith("/canvas/instances") && !init?.method) {
      const cursor = new URL(`http://x${path}`).searchParams.get("cursor") ?? "";
      if (failCursor !== null && cursor === failCursor) throw new Error("offline");
      return pages[cursor];
    }
    if (init?.method === "DELETE") return { ok: true };
    return { ok: true };
  });
});
afterEach(cleanup);

const mine = () => {
  const list = screen.queryByRole("heading", { name: "My designs" })?.closest("section");
  return list ? within(list as HTMLElement) : null;
};

describe("Marketing home: templates you can customize", () => {
  it("lists the published templates that are made in Canvas, each with a Customize button, and nothing else", async () => {
    templates = [
      template("Case Study", { canvasRevision: 2 }),
      template("Blog Post", { canvasRevision: null }), // Figma only: nothing to customize here
      template("Quote", { canvasRevision: 1, published: false }), // a draft (the API never sends one; defence in depth)
    ];
    render(<MarketingHome />);
    expect(await screen.findByText("Case Study", { selector: "p" })).toBeTruthy();
    expect(screen.queryByText("Blog Post")).toBeNull();
    expect(screen.queryByText("Quote")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Customize:/ })).toHaveLength(1);
    expect(screen.getByText("Revision 2")).toBeTruthy();
  });

  it("says so when nothing is ready, and points at the Template Library", async () => {
    templates = [template("Blog Post", { canvasRevision: null })];
    render(<MarketingHome />);
    expect(await screen.findByText(/No template is ready to customize yet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Template Library" }).getAttribute("href")).toBe("/templates");
  });

  it("Customize makes the design from that template (naming only the template) and opens it", async () => {
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/templates") return { templates };
      if (path === "/canvas/instances" && init?.method === "POST") return { instance: { id: "new1", name: "Case Study", version: 1, createdAt: "x", baseRevision: { number: 2, createdAt: "x" } } };
      return pages[""];
    });
    render(<MarketingHome />);
    await userEvent.click(await screen.findByRole("button", { name: "Customize: Case Study" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/canvas/new1"));
    const call = h.apiFetch.mock.calls.find(([p, i]) => p === "/canvas/instances" && i?.method === "POST")!;
    expect(JSON.parse(call[1].body)).toEqual({ templateId: "Case Study" });
  });
});

describe("Marketing home: my designs", () => {
  it("shows them as the server sent them (newest first), with the revision each was made from", async () => {
    render(<MarketingHome />);
    await screen.findByText("Design 3");
    const items = within(mine()!.getByRole("list")).getAllByRole("listitem");
    expect(items.map((li) => within(li).getByText(/^Design \d$/).textContent)).toEqual(["Design 3", "Design 2", "Design 1"]);
    expect(within(items[0]).getByText(/Revision 2/)).toBeTruthy();
    expect(within(items[0]).getByRole("link").getAttribute("href")).toBe("/canvas/i3");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull(); // one page: nothing more
  });

  it("an empty list says so and points at the templates", async () => {
    pages = { "": { instances: [], nextCursor: null } };
    render(<MarketingHome />);
    expect(await screen.findByText("No designs yet")).toBeTruthy();
  });

  it("asks for the first page with no cursor", async () => {
    render(<MarketingHome />);
    await screen.findByText("Design 3");
    const asks = h.apiFetch.mock.calls.map(([p]) => p).filter((p: string) => p.startsWith("/canvas/instances"));
    expect(asks).toEqual(["/canvas/instances"]);
  });

  describe("Load more", () => {
    beforeEach(() => {
      pages = {
        "": { instances: [design(5), design(4)], nextCursor: "c1" },
        c1: { instances: [design(3), design(2)], nextCursor: "c2" },
        c2: { instances: [design(1)], nextCursor: null },
      };
    });

    it("appears while the server has a next page, appends the next one with the cursor it gave, and goes away after the last", async () => {
      render(<MarketingHome />);
      await screen.findByText("Design 5");
      expect(mine()!.getAllByRole("listitem")).toHaveLength(2);
      await userEvent.click(screen.getByRole("button", { name: "Load more" }));
      await screen.findByText("Design 3");
      expect(mine()!.getAllByRole("listitem")).toHaveLength(4);
      await userEvent.click(screen.getByRole("button", { name: "Load more" }));
      await screen.findByText("Design 1");
      expect(mine()!.getAllByRole("listitem")).toHaveLength(5);
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
      const asks = h.apiFetch.mock.calls.map(([p]) => p).filter((p: string) => p.startsWith("/canvas/instances"));
      expect(asks).toEqual(["/canvas/instances", "/canvas/instances?cursor=c1", "/canvas/instances?cursor=c2"]); // each cursor exactly as given
    });

    it("keeps the order of the pages and never shows a design twice, even if a page repeats one", async () => {
      pages.c1 = { instances: [design(4), design(3)], nextCursor: null }; // design 4 again
      render(<MarketingHome />);
      await screen.findByText("Design 5");
      await userEvent.click(screen.getByRole("button", { name: "Load more" }));
      await screen.findByText("Design 3");
      const names = mine()!.getAllByRole("listitem").map((li) => within(li).getByText(/^Design \d$/).textContent);
      expect(names).toEqual(["Design 5", "Design 4", "Design 3"]);
    });

    it("a failed page says so, keeps what is shown, and Try again asks for the same page", async () => {
      failCursor = "c1";
      render(<MarketingHome />);
      await screen.findByText("Design 5");
      await userEvent.click(screen.getByRole("button", { name: "Load more" }));
      expect(await screen.findByText("More designs could not be loaded.")).toBeTruthy();
      expect(mine()!.getAllByRole("listitem")).toHaveLength(2); // nothing lost
      failCursor = null;
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      await screen.findByText("Design 3");
      expect(mine()!.getAllByRole("listitem")).toHaveLength(4);
    });

    it("a second click while a page is loading does not ask twice", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const original = h.apiFetch.getMockImplementation()!;
      h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
        if (path === "/canvas/instances?cursor=c1") await gate;
        return original(path, init);
      });
      render(<MarketingHome />);
      await screen.findByText("Design 5");
      const button = screen.getByRole("button", { name: "Load more" });
      await userEvent.click(button);
      await userEvent.click(button);
      release();
      await screen.findByText("Design 3");
      expect(h.apiFetch.mock.calls.filter(([p]) => p === "/canvas/instances?cursor=c1")).toHaveLength(1);
    });
  });

  it("a list that fails to load offers to try again", async () => {
    let fail = true;
    const original = h.apiFetch.getMockImplementation()!;
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/canvas/instances" && fail) throw new Error("offline");
      return original(path, init);
    });
    render(<MarketingHome />);
    expect(await screen.findByText("Your designs didn't load")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Design 3")).toBeTruthy();
  });

  describe("delete", () => {
    it("asks first; Cancel deletes nothing, Delete design does, and the design leaves the list", async () => {
      render(<MarketingHome />);
      await screen.findByText("Design 2");
      await userEvent.click(screen.getByRole("button", { name: "Delete Design 2" }));
      expect(await screen.findByText("Delete this design?")).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(h.apiFetch.mock.calls.some(([, i]) => i?.method === "DELETE")).toBe(false);
      await userEvent.click(screen.getByRole("button", { name: "Delete Design 2" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete design" }));
      await waitFor(() => expect(screen.queryByText("Design 2")).toBeNull());
      const del = h.apiFetch.mock.calls.find(([, i]) => i?.method === "DELETE")!;
      expect(del[0]).toBe("/canvas/instances/i2");
      expect(screen.getByText("Design 3")).toBeTruthy();
      expect(screen.getByText("Design 1")).toBeTruthy();
    });

    it("a design that was already gone (404) leaves the list too", async () => {
      const original = h.apiFetch.getMockImplementation()!;
      h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
        if (init?.method === "DELETE") throw Object.assign(new Error("Design not found"), { status: 404 });
        return original(path, init);
      });
      render(<MarketingHome />);
      await screen.findByText("Design 1");
      await userEvent.click(screen.getByRole("button", { name: "Delete Design 1" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete design" }));
      await waitFor(() => expect(screen.queryByText("Design 1")).toBeNull());
      expect(h.toast.error).not.toHaveBeenCalled();
    });

    it("any other failure says why and keeps the design", async () => {
      const original = h.apiFetch.getMockImplementation()!;
      h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
        if (init?.method === "DELETE") throw Object.assign(new Error("Server error"), { status: 500 });
        return original(path, init);
      });
      render(<MarketingHome />);
      await screen.findByText("Design 1");
      await userEvent.click(screen.getByRole("button", { name: "Delete Design 1" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete design" }));
      await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Server error"));
      expect(screen.getByText("Design 1")).toBeTruthy();
    });
  });
});
