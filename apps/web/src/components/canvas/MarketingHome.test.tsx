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

/** Nothing submitted yet: the review facts of a design that was never sent. */
const NOT_SUBMITTED = { latestReviewStatus: null, hasChangesSinceSubmitted: false, submissionNumber: null, submittedVersion: null, workingVersion: 1, submittedAt: null, latestReviewId: null, comment: null, decidedAt: null };
const design = (i: number, over: Record<string, unknown> = {}) => ({
  id: `i${i}`,
  name: `Design ${i}`,
  version: 1,
  createdAt: "2026-11-18T10:00:00.000Z",
  updatedAt: "2026-11-18T11:00:00.000Z",
  archivedAt: null,
  review: NOT_SUBMITTED,
  baseRevision: { number: 2 },
  ...over,
});
/** A design that was submitted: its newest review has this status (and the work has/has not moved on since). */
const submitted = (i: number, status: string, over: { changed?: boolean; comment?: string | null; archivedAt?: string | null } = {}) =>
  design(i, {
    archivedAt: over.archivedAt ?? null,
    review: { ...NOT_SUBMITTED, latestReviewStatus: status, hasChangesSinceSubmitted: over.changed ?? false, submissionNumber: 1, submittedVersion: 1, latestReviewId: `r${i}`, comment: over.comment ?? null },
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
/** Pages of the ARCHIVED designs (?archived=1), served by cursor too. */
let archivedPages: Record<string, { instances: unknown[]; nextCursor: string | null }>;

beforeEach(() => {
  vi.clearAllMocks();
  templates = [template("Case Study")];
  pages = { "": { instances: [design(3), design(2), design(1)], nextCursor: null } };
  archivedPages = { "": { instances: [], nextCursor: null } };
  failCursor = null;
  h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/templates") return { templates };
    if (path.startsWith("/canvas/instances") && !init?.method) {
      const query = new URL(`http://x${path}`).searchParams;
      if (query.get("archived") === "1") return archivedPages[query.get("cursor") ?? ""];
      const cursor = query.get("cursor") ?? "";
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

    // Phase 7: a server error (5xx) shows a plain sentence, not whatever text the server happened to send; a 4xx message, which says
    // what to fix, is still shown as it is (canvasProblem in lib/canvas.ts).
    it("a server error says so in plain words and keeps the design", async () => {
      const original = h.apiFetch.getMockImplementation()!;
      h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
        if (init?.method === "DELETE") throw Object.assign(new Error("Server error"), { status: 500 });
        return original(path, init);
      });
      render(<MarketingHome />);
      await screen.findByText("Design 1");
      await userEvent.click(screen.getByRole("button", { name: "Delete Design 1" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete design" }));
      await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Posthive had a problem on its side. Try again in a moment."));
      expect(screen.getByText("Design 1")).toBeTruthy();
    });

    it("a refusal the server worded on purpose (a 4xx) is shown as it is, and keeps the design", async () => {
      const original = h.apiFetch.getMockImplementation()!;
      h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
        if (init?.method === "DELETE") throw Object.assign(new Error("This design is in use."), { status: 409 });
        return original(path, init);
      });
      render(<MarketingHome />);
      await screen.findByText("Design 1");
      await userEvent.click(screen.getByRole("button", { name: "Delete Design 1" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete design" }));
      await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("This design is in use."));
      expect(screen.getByText("Design 1")).toBeTruthy();
    });

    it("a lost connection says the person seems to be offline, not the browser's 'Failed to fetch'", async () => {
      const original = h.apiFetch.getMockImplementation()!;
      h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
        if (init?.method === "DELETE") throw new TypeError("Failed to fetch");
        return original(path, init);
      });
      render(<MarketingHome />);
      await screen.findByText("Design 1");
      await userEvent.click(screen.getByRole("button", { name: "Delete Design 1" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete design" }));
      await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith(expect.stringMatching(/offline/i)));
      expect(h.toast.error).not.toHaveBeenCalledWith("Failed to fetch");
      expect(screen.getByText("Design 1")).toBeTruthy();
    });
  });
});

// ── Phase 6: review state, archive, history ───────────────────────────────────────────────────────────────────────

describe("Marketing home: review state (phase 6)", () => {
  it("shows the answer to the newest submission as a chip, and 'Unsubmitted changes' as a SEPARATE badge, both at once", async () => {
    pages = { "": { instances: [submitted(3, "approved", { changed: true }), submitted(2, "pending"), submitted(1, "changes_requested", { comment: "Make it shorter" }), design(0)], nextCursor: null } };
    render(<MarketingHome />);
    await screen.findByText("Design 3");
    const rows = mine()!.getAllByRole("listitem");
    expect(within(rows[0]).getByText("Approved")).toBeTruthy();
    expect(within(rows[0]).getByText("Unsubmitted changes")).toBeTruthy(); // an edit does not clear "Approved": it adds the badge
    expect(within(rows[1]).getByText("In review")).toBeTruthy();
    expect(within(rows[1]).queryByText("Unsubmitted changes")).toBeNull();
    expect(within(rows[2]).getByText("Changes requested")).toBeTruthy();
    expect(within(rows[2]).getByText(/Make it shorter/)).toBeTruthy(); // the designer's words, to the owner
    expect(within(rows[3]).queryByText(/In review|Approved|Changes requested|Unsubmitted/)).toBeNull(); // never submitted: no answer, no unsubmitted work
    expect(within(rows[3]).getByText("Design draft")).toBeTruthy(); // ... it is a saved design draft, found here and reopened
    for (const i of [0, 1, 2]) expect(within(rows[i]).queryByText("Design draft")).toBeNull(); // a submitted design is not a draft
  });

  it("a design that was never submitted offers Delete; one that was submitted offers Archive and its history instead", async () => {
    pages = { "": { instances: [submitted(2, "pending"), design(1)], nextCursor: null } };
    render(<MarketingHome />);
    await screen.findByText("Design 2");
    expect(screen.getByRole("button", { name: "Archive Design 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete Design 2" })).toBeNull();
    expect(screen.getByRole("link", { name: "Submission history of Design 2" }).getAttribute("href")).toBe("/canvas/i2?view=history");
    expect(screen.getByRole("button", { name: "Delete Design 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive Design 1" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Submission history of Design 1" })).toBeNull();
  });

  it("archiving asks first, says what it means (no editing, no new submission, no restore, history kept), and the design leaves the list", async () => {
    pages = { "": { instances: [submitted(2, "approved"), design(1)], nextCursor: null } };
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/templates") return { templates };
      if (init?.method === "DELETE") return { ok: true, archived: true };
      if (path.startsWith("/canvas/instances")) return new URL(`http://x${path}`).searchParams.get("archived") === "1" ? archivedPages[""] : pages[""];
      return { ok: true };
    });
    render(<MarketingHome />);
    await screen.findByText("Design 2");
    await userEvent.click(screen.getByRole("button", { name: "Archive Design 2" }));
    expect(await screen.findByText("Archive this design?")).toBeTruthy();
    expect(screen.getByText(/can no longer edit it, submit it again or restore it/)).toBeTruthy();
    expect(screen.getByText(/history stays available to you/)).toBeTruthy();
    expect(screen.queryByText(/cannot be undone/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.apiFetch.mock.calls.some(([, i]) => i?.method === "DELETE")).toBe(false); // Cancel archives nothing
    await userEvent.click(screen.getByRole("button", { name: "Archive Design 2" }));
    await userEvent.click(await screen.findByRole("button", { name: "Archive design" }));
    await waitFor(() => expect(screen.queryByText("Design 2")).toBeNull());
    expect(h.apiFetch.mock.calls.find(([, i]) => i?.method === "DELETE")![0]).toBe("/canvas/instances/i2");
    expect(screen.getByText("Design 1")).toBeTruthy();
    expect(h.toast.success).not.toHaveBeenCalled(); // the person asked for Archive and got it: no surprise to explain
  });

  it("a design the list showed as unsubmitted but the server archived (it was submitted from another tab) says so", async () => {
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/templates") return { templates };
      if (init?.method === "DELETE") return { ok: true, archived: true };
      return path.includes("archived=1") ? archivedPages[""] : pages[""];
    });
    render(<MarketingHome />);
    await screen.findByText("Design 1");
    await userEvent.click(screen.getByRole("button", { name: "Delete Design 1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete design" }));
    await waitFor(() => expect(screen.queryByText("Design 1")).toBeNull());
    expect(h.toast.success).toHaveBeenCalledWith("This design had been submitted, so it was archived instead of deleted.");
  });

  it("a failed archive says it was an archive and keeps the design", async () => {
    pages = { "": { instances: [submitted(2, "pending")], nextCursor: null } };
    const original = h.apiFetch.getMockImplementation()!;
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      // a 4xx with no message of its own ("400 error" is apiFetch's placeholder) falls back to the archive wording, not the delete one
      if (init?.method === "DELETE") throw Object.assign(new Error("400 error"), { status: 400 });
      return original(path, init);
    });
    render(<MarketingHome />);
    await screen.findByText("Design 2");
    await userEvent.click(screen.getByRole("button", { name: "Archive Design 2" }));
    await userEvent.click(await screen.findByRole("button", { name: "Archive design" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("The design could not be archived."));
    expect(screen.getByText("Design 2")).toBeTruthy();
  });
});

describe("Marketing home: archived designs (phase 6)", () => {
  const section = () => within(screen.getByRole("heading", { name: /Archived designs/ }).closest("section") as HTMLElement);

  it("is collapsed and asks for nothing until it is opened; the active list never mixes with it", async () => {
    archivedPages = { "": { instances: [submitted(9, "approved", { archivedAt: "2026-11-19T10:00:00.000Z" })], nextCursor: null } };
    render(<MarketingHome />);
    await screen.findByText("Design 3");
    expect(h.apiFetch.mock.calls.some(([p]) => String(p).includes("archived=1"))).toBe(false); // nothing asked yet
    expect(screen.queryByText("Design 9")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Archived designs/ }));
    expect(await screen.findByText("Design 9")).toBeTruthy();
    expect(h.apiFetch.mock.calls.filter(([p]) => String(p).includes("archived=1")).map(([p]) => p)).toEqual(["/canvas/instances?archived=1"]);
    expect(within(mine()!.getByRole("list")).queryByText("Design 9")).toBeNull(); // not in "My designs"
  });

  it("each archived design is read-only: it shows Archived and the last answer, opens its HISTORY (never the editor), and has no delete, archive or restore", async () => {
    archivedPages = { "": { instances: [submitted(9, "changes_requested", { archivedAt: "2026-11-19T10:00:00.000Z" })], nextCursor: null } };
    render(<MarketingHome />);
    await screen.findByText("Design 3");
    await userEvent.click(screen.getByRole("button", { name: /Archived designs/ }));
    await screen.findByText("Design 9");
    const row = section().getByRole("listitem");
    expect(within(row).getByText("Archived", { selector: "span" })).toBeTruthy();
    expect(within(row).getByText("Changes requested")).toBeTruthy();
    expect(within(row).getByRole("link").getAttribute("href")).toBe("/canvas/i9?view=history");
    expect(within(row).queryByRole("button")).toBeNull();
    expect(within(row).queryByText("Unsubmitted changes")).toBeNull(); // a frozen design has no more work to submit
  });

  it("says so when there is nothing archived, and pages with Load more using the cursor it was given", async () => {
    render(<MarketingHome />);
    await screen.findByText("Design 3");
    await userEvent.click(screen.getByRole("button", { name: /Archived designs/ }));
    expect(await screen.findByText("You have not archived any design.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Archived designs/ })); // close
    archivedPages = {
      "": { instances: [submitted(9, "approved", { archivedAt: "2026-11-19T10:00:00.000Z" })], nextCursor: "a1" },
      a1: { instances: [submitted(8, "pending", { archivedAt: "2026-11-19T09:00:00.000Z" })], nextCursor: null },
    };
    await userEvent.click(screen.getByRole("button", { name: /Archived designs/ }));
    await screen.findByText("Design 9");
    await userEvent.click(section().getByRole("button", { name: "Load more" }));
    await screen.findByText("Design 8");
    expect(section().getAllByRole("listitem")).toHaveLength(2);
    expect(h.apiFetch.mock.calls.map(([p]) => p)).toContain("/canvas/instances?cursor=a1&archived=1");
  });

  it("an archived design that is archived just now appears in an open section without reopening it", async () => {
    pages = { "": { instances: [submitted(2, "approved")], nextCursor: null } };
    render(<MarketingHome />);
    await screen.findByText("Design 2");
    await userEvent.click(screen.getByRole("button", { name: /Archived designs/ }));
    await screen.findByText("You have not archived any design.");
    archivedPages = { "": { instances: [submitted(2, "approved", { archivedAt: "2026-11-19T10:00:00.000Z" })], nextCursor: null } };
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/templates") return { templates };
      if (init?.method === "DELETE") return { ok: true, archived: true };
      return path.includes("archived=1") ? archivedPages[""] : { instances: [], nextCursor: null };
    });
    await userEvent.click(screen.getByRole("button", { name: "Archive Design 2" }));
    await userEvent.click(await screen.findByRole("button", { name: "Archive design" }));
    await waitFor(() => expect(within(screen.getByRole("heading", { name: /Archived designs/ }).closest("section") as HTMLElement).getByText("Design 2")).toBeTruthy());
  });

  it("a late 'Load more' from a section that was closed and reopened is dropped: it does not land in the new list or replace its cursor", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    archivedPages = {
      "": { instances: [submitted(9, "approved", { archivedAt: "2026-11-19T10:00:00.000Z" })], nextCursor: "a1" },
      a1: { instances: [submitted(8, "pending", { archivedAt: "2026-11-19T09:00:00.000Z" })], nextCursor: null },
    };
    const original = h.apiFetch.getMockImplementation()!;
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (String(path).includes("cursor=a1")) await gate; // the second page is slow
      return original(path, init);
    });
    render(<MarketingHome />);
    await screen.findByText("Design 3");
    await userEvent.click(screen.getByRole("button", { name: /Archived designs/ }));
    await screen.findByText("Design 9");
    await userEvent.click(section().getByRole("button", { name: "Load more" }));
    await userEvent.click(screen.getByRole("button", { name: /Archived designs/ })); // close, and open again: a new list
    archivedPages = { "": { instances: [submitted(7, "approved", { archivedAt: "2026-11-19T08:00:00.000Z" })], nextCursor: null }, a1: archivedPages.a1 };
    await userEvent.click(screen.getByRole("button", { name: /Archived designs/ }));
    await screen.findByText("Design 7");
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("Design 8")).toBeNull(); // the old list's second page did not land here
    expect(section().queryByRole("button", { name: "Load more" })).toBeNull(); // and its cursor did not replace this list's (none)
  });

  it("a section that fails to load says so", async () => {
    const original = h.apiFetch.getMockImplementation()!;
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (String(path).includes("archived=1")) throw new Error("offline");
      return original(path, init);
    });
    render(<MarketingHome />);
    await screen.findByText("Design 3");
    await userEvent.click(screen.getByRole("button", { name: /Archived designs/ }));
    expect(await screen.findByText(/Archived designs didn't load/)).toBeTruthy();
  });

  // Phase 7: the failed section has its own "Try again" (it used to say "close this section and open it again"). The effect that
  // loads the list only reran when the section opened, so the button needs a counter of its own: this proves it really reads again.
  it("'Try again' on a failed section reads the list again, and shows it when the second read works", async () => {
    let down = true;
    const original = h.apiFetch.getMockImplementation()!;
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (String(path).includes("archived=1")) {
        if (down) throw new TypeError("Failed to fetch");
        return { instances: [submitted(9, "approved", { archivedAt: "2026-11-19T10:00:00.000Z" })], nextCursor: null };
      }
      return original(path, init);
    });
    render(<MarketingHome />);
    await screen.findByText("Design 3");
    await userEvent.click(screen.getByRole("button", { name: /Archived designs/ }));
    await screen.findByText(/Archived designs didn't load/);
    const reads = () => h.apiFetch.mock.calls.filter(([p]) => String(p).includes("archived=1")).length;
    const before = reads();
    down = false;
    await userEvent.click(within(screen.getByRole("heading", { name: /Archived designs/ }).closest("section") as HTMLElement).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(reads()).toBe(before + 1));
    expect(await screen.findByText("Design 9")).toBeTruthy();
    expect(screen.queryByText(/Archived designs didn't load/)).toBeNull();
    // the button that was clicked is gone, and keyboard focus is on the section's own toggle, not dropped to the page
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Archived designs/ }));
  });
});
