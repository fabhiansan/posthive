// @vitest-environment jsdom
// What Marketing submitted for one of its designs: the list, each submission drawn read-only, the designer's answer and name,
// for an active design and an archived one. The engine and the stage are stand-ins (Konva needs a real browser); the network is mocked.
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({ apiFetch: vi.fn(), bootNone: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u, API_BASE: "http://localhost:3001" }));
vi.mock("./CanvasBoot", () => ({ useBootNone: () => h.bootNone() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("./ReadOnlyStage", () => ({ ReadOnlyStage: ({ doc }: { doc: { nodes: Array<{ id: string }> } }) => <div data-testid="stage">{doc.nodes.map((n) => n.id).join(",")}</div> }));
vi.mock("./useCanvasBootstrap", () => ({
  assetIdsOf: (doc: { nodes: Array<{ type: string; assetId?: string }> }) => [...new Set(doc.nodes.flatMap((n) => (n.type === "image" ? [n.assetId] : [])))],
  // Stands in for the real hook: loads through the source once, like it does, and reports the same shapes.
  useOpenedDesign: (id: string, source: { load(id: string): Promise<{ document: unknown }> }) => {
    const [state, setState] = React.useState<{ design: unknown; problem: string | null }>({ design: null, problem: null });
    React.useEffect(() => {
      let live = true;
      source.load(id).then(
        (d) => live && setState({ design: { ...d, images: new Map() }, problem: null }),
        (e: { status?: number }) => live && setState({ design: null, problem: e.status === 404 ? "not-found" : "invalid" }),
      );
      return () => {
        live = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);
    return { engine: state.design ? { stand: "in" } : null, design: state.design, problem: state.problem, failure: null };
  },
}));

import { SubmissionHistory } from "./SubmissionHistory";

const entry = (number: number, over: Record<string, unknown> = {}) => ({
  number, name: "Case Study", note: null, createdAt: "2026-11-18T10:00:00.000Z", status: "pending", comment: null, decidedAt: null, reviewer: null, ...over,
});
const detail = (number: number, ids: string[] = ["head"]) => ({
  ...entry(number),
  baseRevision: { number: 1 },
  document: { schemaVersion: 1, width: 10, height: 10, background: { color: "#FFFFFF" }, nodes: ids.map((id) => ({ id, type: "text" })) },
});

let pages: Record<string, { submissions: unknown[]; nextCursor: string | null }>;
let failList: boolean | number; // true: offline, a number: that HTTP status
let archivedByServer: boolean;
const asks = () => h.apiFetch.mock.calls.map(([p]) => p as string);

beforeEach(() => {
  vi.clearAllMocks();
  failList = false;
  archivedByServer = false;
  pages = {
    "": {
      submissions: [
        entry(3, { status: "pending" }),
        entry(2, { status: "changes_requested", comment: "Make the headline shorter", reviewer: "Dana Designer", note: "Second try", decidedAt: "2026-11-18T12:00:00.000Z" }),
        entry(1, { status: "approved", reviewer: "Former team member", comment: "Good" }),
      ],
      nextCursor: null,
    },
  };
  h.apiFetch.mockImplementation(async (path: string) => {
    const url = new URL(`http://x${path}`);
    const m = url.pathname.match(/^\/canvas\/instances\/([^/]+)\/submissions(?:\/(\d+))?$/);
    if (!m) throw Object.assign(new Error("not found"), { status: 404 });
    if (m[2]) return { submission: detail(Number(m[2]), [`layer-of-${m[2]}`]) };
    if (typeof failList === "number") throw Object.assign(new Error("refused"), { status: failList });
    if (failList) throw new Error("offline");
    return { ...pages[url.searchParams.get("cursor") ?? ""], archived: archivedByServer };
  });
});
afterEach(cleanup);

describe("the list", () => {
  it("shows every submission, newest first, with the status, the date and who answered, by NAME", async () => {
    render(<SubmissionHistory designId="i1" />);
    const list = await screen.findByRole("list", { name: "Submissions" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => within(li).getByText(/^Submission \d$/).textContent)).toEqual(["Submission 3", "Submission 2", "Submission 1"]);
    expect(within(items[0]).getByText("In review")).toBeTruthy();
    expect(within(items[1]).getByText("Changes requested")).toBeTruthy();
    expect(within(items[1]).getByText("Answered by Dana Designer")).toBeTruthy();
    expect(within(items[2]).getByText("Answered by Former team member")).toBeTruthy(); // an account that no longer exists
    expect(within(items[0]).queryByText(/Answered by/)).toBeNull(); // nothing yet
    expect(asks()[0]).toBe("/canvas/instances/i1/submissions");
  });

  it("opens the NEWEST submission by default, read-only, and loads another when it is chosen", async () => {
    render(<SubmissionHistory designId="i1" />);
    expect((await screen.findByTestId("stage")).textContent).toBe("layer-of-3");
    expect(asks()).toContain("/canvas/instances/i1/submissions/3");
    await userEvent.click(screen.getByRole("button", { name: /Submission 2/ }));
    await waitFor(() => expect(screen.getByTestId("stage").textContent).toBe("layer-of-2"));
    expect(asks()).toContain("/canvas/instances/i1/submissions/2");
    expect(screen.getByRole("button", { name: /Submission 2/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /Submission 3/ }).getAttribute("aria-current")).toBeNull();
  });

  it("shows the note and the designer's words for the chosen submission, with the reviewer's name", async () => {
    render(<SubmissionHistory designId="i1" />);
    await screen.findByTestId("stage");
    await userEvent.click(screen.getByRole("button", { name: /Submission 2/ }));
    expect(await screen.findByText("Your note:")).toBeTruthy();
    expect(screen.getByText("Second try")).toBeTruthy();
    expect(screen.getByText("Changes requested by Dana Designer:")).toBeTruthy();
    expect(screen.getByText("Make the headline shorter")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Submission 1/ }));
    expect(await screen.findByText("Approved by Former team member:")).toBeTruthy();
  });

  it("is read-only: nothing to edit, submit, archive or delete anywhere on the screen", async () => {
    render(<SubmissionHistory designId="i1" />);
    await screen.findByTestId("stage");
    expect(screen.queryByRole("textbox")).toBeNull();
    for (const name of [/submit/i, /archive/i, /delete/i, /restore/i, /edit/i, /save/i]) expect(screen.queryByRole("button", { name }), String(name)).toBeNull();
    expect(h.apiFetch.mock.calls.every(([, init]) => !init || !init.method || init.method === "GET")).toBe(true); // it only reads
  });

  it("pages with Load more, using the cursor the server gave, and never shows a submission twice", async () => {
    pages = {
      "": { submissions: [entry(3), entry(2)], nextCursor: "2" },
      "2": { submissions: [entry(2), entry(1, { status: "approved" })], nextCursor: null }, // 2 again
    };
    render(<SubmissionHistory designId="i1" />);
    await screen.findByRole("list", { name: "Submissions" });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Submission \d/ })).toHaveLength(3));
    expect(asks()).toContain("/canvas/instances/i1/submissions?cursor=2");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});

describe("states", () => {
  it("says a design is archived because the SERVER says so (whichever address opened the page), and an active one does not", async () => {
    archivedByServer = true;
    const { unmount } = render(<SubmissionHistory designId="i1" />);
    expect(await screen.findByText(/This design was archived\. It can no longer be edited or submitted/)).toBeTruthy();
    unmount();
    archivedByServer = false;
    render(<SubmissionHistory designId="i1" />);
    await screen.findByTestId("stage");
    expect(screen.queryByText(/This design was archived/)).toBeNull();
  });

  it("an empty history says nothing was submitted", async () => {
    pages = { "": { submissions: [], nextCursor: null } };
    render(<SubmissionHistory designId="i1" />);
    expect(await screen.findByText("Nothing was submitted for this design yet.")).toBeTruthy();
    expect(screen.queryByTestId("stage")).toBeNull();
  });

  it("a list that fails to load offers to try again", async () => {
    failList = true;
    render(<SubmissionHistory designId="i1" />);
    expect(await screen.findByText(/The history didn't load/)).toBeTruthy();
    failList = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Submissions" })).toBeTruthy();
  });

  it("a design that does not exist (404) says so instead of blaming the connection, and offers no retry", async () => {
    failList = 404;
    render(<SubmissionHistory designId="i1" />);
    expect(await screen.findByText("This design doesn't exist, or it isn't yours.")).toBeTruthy();
    expect(screen.queryByText(/Check your connection/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Canvas", hidden: false }).getAttribute("href")).toBe("/canvas");
  });

  it("tells the first-open loader there is no editor to wait for, in every state: ready, empty, failed and missing (a hard load of ?view=history must not hang on it)", async () => {
    for (const setup of [() => {}, () => (pages = { "": { submissions: [], nextCursor: null } }), () => (failList = true), () => (failList = 404)]) {
      failList = false;
      pages = { "": { submissions: [entry(1)], nextCursor: null } };
      setup();
      h.bootNone.mockClear();
      const { unmount } = render(<SubmissionHistory designId="i1" />);
      expect(h.bootNone).toHaveBeenCalled();
      unmount();
    }
  });

  it("a late 'Load more' that belongs to an older load is dropped: it neither appends to the new list nor replaces its cursor", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    pages = {
      "": { submissions: [entry(3), entry(2)], nextCursor: "2" },
      "2": { submissions: [entry(1)], nextCursor: null },
    };
    const original = h.apiFetch.getMockImplementation()!;
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("?cursor=2")) await gate; // the second page is slow
      return original(path);
    });
    const { rerender } = render(<SubmissionHistory designId="i1" />);
    await screen.findByRole("list", { name: "Submissions" });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    // meanwhile another design is opened (the component is reused with a new id): its own list loads
    pages = { ...pages, "": { submissions: [entry(9)], nextCursor: null } }; // the old design's second page ("2") stays answerable: it must arrive and be dropped
    rerender(<SubmissionHistory designId="i2" />);
    await screen.findByRole("button", { name: /Submission 9/ });
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getAllByRole("button", { name: /^Submission \d/ })).toHaveLength(1); // only the new design's own submission: the old design's page did not land here
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull(); // and its cursor did not replace this list's (none)
  });

  it("a submission that cannot be shown says so and keeps the list", async () => {
    const original = h.apiFetch.getMockImplementation()!;
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/submissions/3")) throw Object.assign(new Error("gone"), { status: 404 });
      return original(path);
    });
    render(<SubmissionHistory designId="i1" />);
    expect(await screen.findByText("This submission can't be shown.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Submission \d/ })).toHaveLength(3);
  });

  it("goes back to Canvas", async () => {
    render(<SubmissionHistory designId="i1" />);
    expect((await screen.findByRole("link", { name: /Canvas/ })).getAttribute("href")).toBe("/canvas");
  });
});
