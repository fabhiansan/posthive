// @vitest-environment jsdom
// The design team's review page: the queue (waiting / answered), one submission drawn read-only with what changed, and the
// decision (approve, or request changes with a comment). The engine and the stage are stand-ins; the network is mocked.
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  replace: vi.fn(),
  review: null as string | null, // the ?review= parameter
  toast: { toast: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u, API_BASE: "http://localhost:3001" }));
vi.mock("@/components/Toast", () => ({ useToast: () => h.toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace }), useSearchParams: () => ({ get: (k: string) => (k === "review" ? h.review : null) }) }));
vi.mock("./ReadOnlyStage", () => ({ ReadOnlyStage: ({ doc }: { doc: { nodes: Array<{ id: string }> } }) => <div data-testid="stage">{doc.nodes.map((n) => n.id).join(",")}</div> }));
vi.mock("./useCanvasBootstrap", () => ({
  assetIdsOf: (doc: { nodes: Array<{ type: string; assetId?: string }> }) => [...new Set(doc.nodes.flatMap((n) => (n.type === "image" ? [n.assetId] : [])))],
  useOpenedDesign: (id: string, source: { load(id: string): Promise<{ document: unknown }> }) => {
    const [state, setState] = React.useState<{ design: unknown; problem: string | null }>({ design: null, problem: null });
    React.useEffect(() => {
      let live = true;
      source.load(id).then(
        (d) => live && setState({ design: { ...d, images: new Map() }, problem: null }),
        (e: { status?: number }) => live && setState({ design: null, problem: e.status === 404 ? "not-found" : e.status === 403 ? "forbidden" : "invalid" }),
      );
      return () => {
        live = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);
    return { engine: state.design ? { stand: "in" } : null, design: state.design, problem: state.problem, failure: null };
  },
}));

import { COMMENT_MAX, ReviewsWorkspace, decisionProblem } from "./ReviewsWorkspace";

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: "pending", createdAt: "2026-11-18T10:00:00.000Z", decidedAt: null, number: 1, name: `Design ${id}`, note: null, baseRevisionNumber: 2, submitter: "Mia Marketing", archivedBySubmitter: false, ...over,
});
const detail = (id: string, over: Record<string, unknown> = {}) => ({
  review: { id, status: "pending", comment: null, createdAt: "2026-11-18T10:00:00.000Z", decidedAt: null, reviewer: null },
  submission: { number: 2, name: `Design ${id}`, note: "Please check the headline", createdAt: "2026-11-18T10:00:00.000Z", submitter: "Mia Marketing", baseRevision: { number: 2 }, document: { schemaVersion: 1, width: 10, height: 10, background: { color: "#FFFFFF" }, nodes: [{ id: "head", type: "text" }] } },
  changes: [
    { nodeId: "head", name: "Headline", kind: "text", before: "Old headline", after: "New headline" },
    { nodeId: "photo", name: "Photo", kind: "image", before: "asset-1", after: "asset-2" },
  ],
  history: [
    { number: 2, name: "x", createdAt: "2026-11-18T10:00:00.000Z", reviewId: id, status: "pending", decidedAt: null },
    { number: 1, name: "x", createdAt: "2026-11-17T10:00:00.000Z", reviewId: "old", status: "superseded", decidedAt: null },
  ],
  archivedBySubmitter: false,
  ...over,
});

let queue: Record<string, { reviews: unknown[]; nextCursor: string | null }>; // keyed by `${view}` or `${view}:${cursor}`
let details: Record<string, unknown>;
let decideFails: unknown;
const asks = () => h.apiFetch.mock.calls.map(([p]) => p as string);
const posts = () => h.apiFetch.mock.calls.filter(([, i]) => i?.method === "POST");

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  h.review = null;
  decideFails = null;
  queue = { pending: { reviews: [row("r1"), row("r2", { archivedBySubmitter: true })], nextCursor: null }, decided: { reviews: [row("r9", { status: "approved" })], nextCursor: null } };
  details = { r1: detail("r1"), r2: detail("r2") };
  h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/canvas/reviews/summary") return { pending: 2, latestSubmittedAt: "2026-11-18T10:00:00.000Z" };
    const url = new URL(`http://x${path}`);
    if (url.pathname === "/canvas/reviews") {
      const key = `${url.searchParams.get("status")}${url.searchParams.get("cursor") ? `:${url.searchParams.get("cursor")}` : ""}`;
      return queue[key];
    }
    const d = url.pathname.match(/^\/canvas\/reviews\/([^/]+)\/decision$/);
    if (d && init?.method === "POST") {
      if (decideFails) throw decideFails;
      return { ok: true, review: { id: d[1], status: JSON.parse(init.body!).decision === "approve" ? "approved" : "changes_requested" } };
    }
    const one = url.pathname.match(/^\/canvas\/reviews\/([^/]+)$/);
    if (one && details[one[1]]) return details[one[1]];
    throw Object.assign(new Error("Review not found"), { status: 404, data: { error: "Review not found" } });
  });
});
afterEach(cleanup);

describe("the queue", () => {
  it("lists what waits, with the submitter's NAME and the design, and flags a design its owner archived", async () => {
    render(<ReviewsWorkspace />);
    const list = await screen.findByRole("list", { name: "Waiting for review" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Design r1")).toBeTruthy();
    expect(within(items[0]).getByText(/Submission 1 · Mia Marketing/)).toBeTruthy();
    expect(within(items[0]).getByText("In review")).toBeTruthy();
    expect(within(items[0]).queryByText("Archived by submitter")).toBeNull();
    expect(within(items[1]).getByText("Archived by submitter")).toBeTruthy();
    expect(asks()).toContain("/canvas/reviews?status=pending");
  });

  it("the Answered tab asks for the answered ones", async () => {
    render(<ReviewsWorkspace />);
    await screen.findByRole("list", { name: "Waiting for review" });
    await userEvent.click(screen.getByRole("tab", { name: "Answered" }));
    const list = await screen.findByRole("list", { name: "Answered" });
    expect(within(list).getByText("Design r9")).toBeTruthy();
    expect(within(list).getByText("Approved")).toBeTruthy();
    expect(asks()).toContain("/canvas/reviews?status=decided");
    expect(screen.getByRole("tab", { name: "Answered" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens one by putting its id in the address (so a link works), and says what to do when none is chosen", async () => {
    render(<ReviewsWorkspace />);
    expect(await screen.findByText("Choose a design from the list to review it.")).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: /Design r1/ }));
    expect(h.replace).toHaveBeenCalledWith("/canvas/reviews?review=r1");
  });

  it("empty queues say so", async () => {
    queue = { pending: { reviews: [], nextCursor: null }, decided: { reviews: [], nextCursor: null } };
    render(<ReviewsWorkspace />);
    expect(await screen.findByText(/No designs are waiting for review/)).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Answered" }));
    expect(await screen.findByText("Nothing has been answered yet.")).toBeTruthy();
  });

  it("pages with Load more and the cursor the server gave, and never shows a review twice", async () => {
    queue = { pending: { reviews: [row("r1")], nextCursor: "c1" }, "pending:c1": { reviews: [row("r1"), row("r2")], nextCursor: null }, decided: { reviews: [], nextCursor: null } };
    render(<ReviewsWorkspace />);
    await screen.findByRole("list", { name: "Waiting for review" });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Design r/ })).toHaveLength(2));
    expect(asks()).toContain("/canvas/reviews?status=pending&cursor=c1");
  });

  it("a queue that fails to load offers to try again", async () => {
    const original = h.apiFetch.getMockImplementation()!;
    let fail = true;
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (fail && path.startsWith("/canvas/reviews?")) throw new Error("offline");
      return original(path, init);
    });
    render(<ReviewsWorkspace />);
    expect(await screen.findByText("The reviews didn't load.")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Waiting for review" })).toBeTruthy();
  });

  it("looking at the queue records where this browser last looked (for the indicator's dot)", async () => {
    render(<ReviewsWorkspace />);
    await screen.findByRole("list", { name: "Waiting for review" });
    await waitFor(() => expect(window.localStorage.getItem("canvas-reviews-seen")).toBe("2026-11-18T10:00:00.000Z"));
  });
});

describe("one submission", () => {
  beforeEach(() => {
    h.review = "r1";
  });

  it("is drawn read-only from the submitted document, with who sent it, the note, and what changed", async () => {
    render(<ReviewsWorkspace />);
    expect((await screen.findByTestId("stage")).textContent).toBe("head");
    expect(asks()).toContain("/canvas/reviews/r1");
    expect(screen.getByText(/Submission 2 by Mia Marketing/)).toBeTruthy();
    expect(screen.getByText(/Based on revision 2/)).toBeTruthy();
    expect(screen.getByText("Please check the headline")).toBeTruthy();
    expect(screen.getByText("Old headline")).toBeTruthy();
    expect(screen.getByText("New headline")).toBeTruthy();
    expect(screen.getByText("Image replaced")).toBeTruthy();
  });

  it("no change says what it was compared with: the published revision for the first, the previous submission after", async () => {
    details.r1 = detail("r1", { changes: [], submission: { ...(detail("r1").submission as object), number: 1 } });
    const { unmount } = render(<ReviewsWorkspace />);
    expect(await screen.findByText("Nothing was changed from the published revision.")).toBeTruthy();
    unmount();
    details.r1 = detail("r1", { changes: [] });
    render(<ReviewsWorkspace />);
    expect(await screen.findByText("Nothing differs from the previous submission.")).toBeTruthy();
  });

  it("lists the earlier submissions of the design with their answers", async () => {
    render(<ReviewsWorkspace />);
    const section = (await screen.findByRole("heading", { name: "Earlier submissions" })).closest("section") as HTMLElement;
    expect(within(section).getAllByRole("listitem")).toHaveLength(2);
    expect(within(section).getByText("Replaced")).toBeTruthy();
  });

  it("an archived design's pending submission still shows, flagged, and can still be answered", async () => {
    h.review = "r2";
    details.r2 = detail("r2", { archivedBySubmitter: true });
    render(<ReviewsWorkspace />);
    await screen.findByTestId("stage");
    expect(screen.getAllByText("Archived by submitter").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: /Approve/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a review that is not there is dropped from the address with a notice, and the list is read again", async () => {
    h.review = "gone";
    render(<ReviewsWorkspace />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/canvas/reviews"));
    expect(h.toast.warning).toHaveBeenCalledWith("That review is no longer there.");
  });

  it("says so ONCE, and asks for the review once, even though the address change that follows is asynchronous (here it never happens)", async () => {
    h.review = "gone"; // router.replace is a no-op in this test, so ?review= stays: the pane must not loop on it
    render(<ReviewsWorkspace />);
    await waitFor(() => expect(h.toast.warning).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 60));
    expect(h.toast.warning).toHaveBeenCalledTimes(1);
    expect(h.replace).toHaveBeenCalledTimes(1);
    expect(asks().filter((p) => p === "/canvas/reviews/gone")).toHaveLength(1);
    expect(asks().filter((p) => p === "/canvas/reviews?status=pending")).toHaveLength(2); // the list was read again, once
  });

  it("shows a rename as a change of its own, though no field differs", async () => {
    details.r1 = detail("r1", { changes: [], rename: { before: "Case Study", after: "Case Study Q4" } });
    render(<ReviewsWorkspace />);
    expect(await screen.findByText("Design name")).toBeTruthy();
    expect(screen.getByText("Case Study")).toBeTruthy();
    expect(screen.getByText("Case Study Q4")).toBeTruthy();
    expect(screen.queryByText("Nothing differs from the previous submission.")).toBeNull();
  });

  it("a late 'Load more' from the other tab is dropped: it does not land in this list or replace its cursor", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.review = null;
    queue = {
      pending: { reviews: [row("r1")], nextCursor: "p1" },
      "pending:p1": { reviews: [row("r5")], nextCursor: null },
      decided: { reviews: [row("r9", { status: "approved" })], nextCursor: null },
    };
    const original = h.apiFetch.getMockImplementation()!;
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.includes("cursor=p1")) await gate;
      return original(path, init);
    });
    render(<ReviewsWorkspace />);
    await screen.findByRole("list", { name: "Waiting for review" });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await userEvent.click(screen.getByRole("tab", { name: "Answered" })); // switch before the page arrives
    const answered = await screen.findByRole("list", { name: "Answered" });
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(within(answered).queryByText("Design r5")).toBeNull(); // the waiting page did not land in the answered list
    expect(within(answered).getByText("Design r9")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull(); // and the answered list has no next cursor to be overwritten
  });
});

describe("answering", () => {
  beforeEach(() => {
    h.review = "r1";
  });

  it("Approve sends the decision (with the comment if one was written, trimmed), says so, and reads the queue and the review again", async () => {
    render(<ReviewsWorkspace />);
    await screen.findByTestId("stage");
    await userEvent.type(screen.getByLabelText("Comment"), "  Looks good ");
    const before = asks().length;
    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Approved"));
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe("/canvas/reviews/r1/decision");
    expect(JSON.parse(posts()[0][1].body)).toEqual({ decision: "approve", comment: "Looks good" });
    await waitFor(() => expect(asks().length).toBeGreaterThan(before + 1)); // the queue and the detail again
    expect(asks().filter((p) => p === "/canvas/reviews/r1").length).toBe(2);
  });

  it("approving needs no comment", async () => {
    render(<ReviewsWorkspace />);
    await screen.findByTestId("stage");
    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ decision: "approve" });
  });

  it("Request changes needs a comment: off while it is blank, with the reason, and sends it once there is one", async () => {
    render(<ReviewsWorkspace />);
    await screen.findByTestId("stage");
    const ask = screen.getByRole("button", { name: /Request changes/ }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    expect(ask.title).toBe("Say what needs to change.");
    await userEvent.type(screen.getByLabelText("Comment"), "   ");
    expect(ask.disabled).toBe(true); // spaces are not a comment
    await userEvent.type(screen.getByLabelText("Comment"), "Shorter headline");
    expect(ask.disabled).toBe(false);
    await userEvent.click(ask);
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Sent back with your comment"));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ decision: "request_changes", comment: "Shorter headline" });
  });

  it("the comment is held to 2000 characters, with a counter", async () => {
    render(<ReviewsWorkspace />);
    await screen.findByTestId("stage");
    expect(COMMENT_MAX).toBe(2000);
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).maxLength).toBe(2000);
    await userEvent.type(screen.getByLabelText("Comment"), "abcd");
    expect(screen.getByText("4 / 2000")).toBeTruthy();
  });

  it("a review answered meanwhile (409 NOT_PENDING) says so in words and the page reads what is true now", async () => {
    decideFails = Object.assign(new Error("already"), { status: 409, data: { code: "NOT_PENDING", error: "x" } });
    render(<ReviewsWorkspace />);
    await screen.findByTestId("stage");
    const before = asks().filter((p) => p === "/canvas/reviews/r1").length;
    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("This review was already answered, or a newer submission replaced it. The list was refreshed."));
    await waitFor(() => expect(asks().filter((p) => p === "/canvas/reviews/r1").length).toBe(before + 1));
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it("any other failure is told in words and the person can try again (the buttons come back)", async () => {
    decideFails = Object.assign(new Error("Error"), { status: 500, data: { statusCode: 500, error: "Error", message: "Internal Server Error" } });
    render(<ReviewsWorkspace />);
    await screen.findByTestId("stage");
    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Posthive had a problem on its side. Try again in a moment."));
    await waitFor(() => expect((screen.getByRole("button", { name: /Approve/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(asks().filter((p) => p === "/canvas/reviews/r1").length).toBe(1); // not reloaded: nothing changed
  });

  it("an answered review shows the answer, who gave it and when, and offers no buttons", async () => {
    details.r1 = detail("r1", { review: { id: "r1", status: "changes_requested", comment: "Shorter please", createdAt: "x", decidedAt: "2026-11-18T12:00:00.000Z", reviewer: "Dana Designer" } });
    render(<ReviewsWorkspace />);
    await screen.findByTestId("stage");
    const section = screen.getByRole("region", { name: "Answer" });
    expect(within(section).getByText("Changes requested by Dana Designer")).toBeTruthy();
    expect(within(section).getByText("Shorter please")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Request changes/ })).toBeNull();
    expect(screen.queryByLabelText("Comment")).toBeNull();
  });

  it("a replaced review says so and cannot be answered", async () => {
    details.r1 = detail("r1", { review: { id: "r1", status: "superseded", comment: null, createdAt: "x", decidedAt: null, reviewer: null } });
    render(<ReviewsWorkspace />);
    await screen.findByTestId("stage");
    expect(screen.getByText("Replaced by a newer submission")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });

  it("decisionProblem has plain words for each failure", () => {
    expect(decisionProblem({ data: { code: "NOT_PENDING" } })).toMatch(/already answered/);
    expect(decisionProblem({ status: 404 })).toBe("This review no longer exists.");
    expect(decisionProblem({ status: 429 })).toBe("You are answering too fast. Wait a moment and try again.");
    expect(decisionProblem({ status: 400, data: { error: "Say what needs to change." } })).toBe("Say what needs to change.");
    expect(decisionProblem(new Error("boom"))).toBe("boom");
    expect(decisionProblem(null)).toBe("The answer could not be saved.");
    // the bodies the API really sends for a fault: never shown as they are (see submitProblem)
    expect(decisionProblem({ status: 500, data: { statusCode: 500, error: "Error", message: "Internal Server Error" } })).toMatch(/problem on its side/i);
    expect(decisionProblem({ status: 503, data: { statusCode: 503, error: "Service Unavailable", message: "Sign-in is busy" } })).toMatch(/busy/i);
  });
});
