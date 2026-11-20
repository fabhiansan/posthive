// @vitest-environment jsdom
// Regression: choosing a design in /canvas/reviews crashed with "Maximum update depth exceeded" (ReadOnlyStage kept CanvasStage's
// handle in state). ReviewsWorkspace.test.tsx stands the stage in, so it could not see it. Here the REAL ReadOnlyStage and the
// REAL engine (Konva in jsdom) run; only the network, the toast and the loader hook are replaced, and the address is reactive so a
// click on a row really opens the pane.
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as realEngine from "posthive-canvas";

const h = vi.hoisted(() => {
  let review: string | null = null;
  const listeners = new Set<() => void>();
  return {
    apiFetch: vi.fn(),
    toast: { toast: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    get: () => review,
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
    set: (v: string | null) => {
      review = v;
      listeners.forEach((l) => l());
    },
  };
});
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u, API_BASE: "http://localhost:3001" }));
vi.mock("@/components/Toast", () => ({ useToast: () => h.toast }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (url: string) => h.set(url.match(/review=([^&]+)/)?.[1] ?? null) }),
  useSearchParams: () => {
    const review = React.useSyncExternalStore(h.subscribe, h.get, h.get);
    return { get: (k: string) => (k === "review" ? review : null) };
  },
}));
vi.mock("./useCanvasBootstrap", () => ({
  assetIdsOf: () => [],
  useOpenedDesign: (id: string, source: { load(id: string): Promise<unknown> }) => {
    const [design, setDesign] = React.useState<unknown>(null);
    React.useEffect(() => {
      let live = true;
      source.load(id).then((d) => live && setDesign({ ...(d as object), images: new Map() }));
      return () => {
        live = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);
    return { engine: design ? realEngine : null, design, problem: null, failure: null };
  },
}));

import { ReviewsWorkspace } from "./ReviewsWorkspace";

const row = (id: string) => ({ id, status: "pending", createdAt: "2026-11-18T10:00:00.000Z", decidedAt: null, number: 1, name: `Design ${id}`, note: null, baseRevisionNumber: 2, submitter: "Mia Marketing", archivedBySubmitter: false });
const detail = (id: string) => ({
  review: { id, status: "pending", comment: null, createdAt: "2026-11-18T10:00:00.000Z", decidedAt: null, reviewer: null },
  submission: { number: 1, name: `Design ${id}`, note: null, createdAt: "2026-11-18T10:00:00.000Z", submitter: "Mia Marketing", baseRevision: { number: 2 }, document: realEngine.createDocument() },
  changes: [],
  history: [{ number: 1, name: `Design ${id}`, createdAt: "2026-11-18T10:00:00.000Z", reviewId: id, status: "pending", decidedAt: null }],
  archivedBySubmitter: false,
});

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  h.set(null);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  h.apiFetch.mockImplementation(async (path: string) => {
    if (path === "/canvas/reviews/summary") return { pending: 2, latestSubmittedAt: "2026-11-18T10:00:00.000Z" };
    if (path.startsWith("/canvas/reviews?")) return { reviews: [row("r1"), row("r2")], nextCursor: null };
    const one = path.match(/^\/canvas\/reviews\/([^/]+)$/);
    if (one) return detail(one[1]);
    throw Object.assign(new Error("not found"), { status: 404 });
  });
});
afterEach(() => {
  cleanup();
  errors.mockRestore();
});

describe("choosing a review draws the submission without an update loop", () => {
  it("opens a review from the list, then another, and the zoom controls are there each time", async () => {
    render(<ReviewsWorkspace />);
    const list = await screen.findByRole("list", { name: "Waiting for review" });

    await userEvent.click(within(list).getByRole("button", { name: /Design r1/ }));
    expect(await screen.findByRole("heading", { name: "Design r1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fit to screen" })).toBeTruthy();

    await userEvent.click(within(list).getByRole("button", { name: /Design r2/ }));
    expect(await screen.findByRole("heading", { name: "Design r2" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await userEvent.click(screen.getByRole("button", { name: "Fit to screen" }));

    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/Maximum update depth/);
  });

  it("opening straight from the address (?review=) does the same", async () => {
    h.set("r1");
    render(<ReviewsWorkspace />);
    expect(await screen.findByRole("heading", { name: "Design r1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy();
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/Maximum update depth/);
  });
});
