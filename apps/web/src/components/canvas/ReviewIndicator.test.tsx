// @vitest-environment jsdom
// The design team's indicator: how many designs wait, polled every minute while the tab is visible, with a toast when the count
// goes up and a "new since last visit" dot kept in localStorage (a convenience only: it must work when storage throws).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  push: vi.fn(),
  toast: { toast: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u, API_BASE: "http://localhost:3001" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => h.toast }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { POLL_MS, ReviewIndicator, hasUnseen, markReviewsSeen } from "./ReviewIndicator";

let summary: { pending: number; latestSubmittedAt: string | null } | Error;
const visible = (state: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
const polls = () => h.apiFetch.mock.calls.filter(([p]) => p === "/canvas/reviews/summary").length;
/** Lets the awaited request and its state update finish. */
const flush = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  window.localStorage.clear();
  visible("visible");
  summary = { pending: 0, latestSubmittedAt: null };
  h.apiFetch.mockImplementation(async () => {
    if (summary instanceof Error) throw summary;
    return summary;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  visible("visible");
});

describe("hasUnseen", () => {
  it("something newer than the last look, or a first look at anything", () => {
    expect(hasUnseen(null, null)).toBe(false);
    expect(hasUnseen(null, "2026-01-01T00:00:00.000Z")).toBe(false);
    expect(hasUnseen("2026-01-02T00:00:00.000Z", null)).toBe(true);
    expect(hasUnseen("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(true);
    expect(hasUnseen("2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z")).toBe(false);
    expect(hasUnseen("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")).toBe(false);
  });
});

describe("the indicator", () => {
  it("is a link to the queue, with the count of what waits; nothing is counted when nothing waits", async () => {
    render(<ReviewIndicator />);
    await flush();
    expect(screen.getByRole("link", { name: "Reviews" }).getAttribute("href")).toBe("/canvas/reviews");
    expect(screen.queryByText("0")).toBeNull();
    cleanup();
    summary = { pending: 3, latestSubmittedAt: "2026-01-02T00:00:00.000Z" };
    render(<ReviewIndicator />);
    await flush();
    expect(screen.getByRole("link", { name: "Reviews, 3 waiting" })).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("asks at once, then every minute while the tab is visible, and not while it is hidden", async () => {
    render(<ReviewIndicator />);
    await flush();
    expect(polls()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(polls()).toBe(2);
    visible("hidden");
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 3));
    expect(polls()).toBe(2); // nothing while hidden
    visible("visible");
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(polls()).toBe(3);
    expect(POLL_MS).toBe(60_000);
  });

  it("asks again when the tab or window is focused or becomes visible", async () => {
    render(<ReviewIndicator />);
    await flush();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(polls()).toBe(2);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(polls()).toBe(3);
    visible("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(polls()).toBe(3); // hidden: no request
  });

  it("says so ONCE when the count goes up, and never on the first reading, a drop or an unchanged count", async () => {
    summary = { pending: 2, latestSubmittedAt: "2026-01-02T00:00:00.000Z" };
    render(<ReviewIndicator />);
    await flush();
    expect(h.toast.success).not.toHaveBeenCalled(); // the first reading is not news
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(h.toast.success).not.toHaveBeenCalled(); // unchanged
    summary = { pending: 3, latestSubmittedAt: "2026-01-03T00:00:00.000Z" };
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(h.toast.success).toHaveBeenCalledTimes(1);
    expect(h.toast.success).toHaveBeenCalledWith("New design submitted for review");
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(h.toast.success).toHaveBeenCalledTimes(1); // the same count again: not again
    summary = { pending: 1, latestSubmittedAt: "2026-01-03T00:00:00.000Z" };
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(h.toast.success).toHaveBeenCalledTimes(1); // a drop is not news
    expect(screen.getByRole("link", { name: "Reviews, 1 waiting" })).toBeTruthy();
  });

  it("a failed poll keeps what is shown and tries again next time, without a toast", async () => {
    summary = { pending: 2, latestSubmittedAt: null };
    render(<ReviewIndicator />);
    await flush();
    summary = new Error("offline");
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(screen.getByRole("link", { name: "Reviews, 2 waiting" })).toBeTruthy();
    expect(h.toast.error).not.toHaveBeenCalled();
    summary = { pending: 4, latestSubmittedAt: null };
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(screen.getByRole("link", { name: "Reviews, 4 waiting" })).toBeTruthy();
    expect(h.toast.success).toHaveBeenCalledTimes(1); // 2 -> 4 is still a rise
  });

  it("stops asking when it is removed from the page", async () => {
    const { unmount } = render(<ReviewIndicator />);
    await flush();
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 3));
    window.dispatchEvent(new Event("focus"));
    expect(polls()).toBe(1);
  });
});

describe("leaving an editor through the indicator (the editor's save-first guard)", () => {
  const link = () => screen.getByRole("link", { name: /Reviews/ });

  it("without a guard (the home page) it is a plain link: nothing is intercepted", async () => {
    render(<ReviewIndicator />);
    await flush();
    const proceeded = fireEvent.click(link()); // false when something called preventDefault
    expect(proceeded).toBe(true);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("with a guard, a plain click waits for it and goes to the queue only when it says yes", async () => {
    const guard = vi.fn(async () => true);
    render(<ReviewIndicator beforeLeave={guard} />);
    await flush();
    const proceeded = fireEvent.click(link());
    expect(proceeded).toBe(false); // the browser's own navigation was cancelled
    await flush();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith("/canvas/reviews");
  });

  it("when the guard says no (unsaved changes, and the person chose to stay) it stays put", async () => {
    const guard = vi.fn(async () => false);
    render(<ReviewIndicator beforeLeave={guard} />);
    await flush();
    fireEvent.click(link());
    await flush();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("a click that opens a new tab or window (a modifier key, or not the main button) is left alone and never asks the guard", async () => {
    const guard = vi.fn(async () => true);
    render(<ReviewIndicator beforeLeave={guard} />);
    await flush();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(fireEvent.click(link(), init), JSON.stringify(init)).toBe(true);
    }
    await flush();
    expect(guard).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });
});

describe("the 'new since last visit' dot (localStorage, a convenience only)", () => {
  it("shows when the newest submission is newer than the last look, and goes after the queue was looked at", async () => {
    summary = { pending: 1, latestSubmittedAt: "2026-01-02T00:00:00.000Z" };
    const { unmount } = render(<ReviewIndicator />);
    await flush();
    expect(screen.getByTestId("unseen-dot")).toBeTruthy();
    unmount();
    markReviewsSeen("2026-01-02T00:00:00.000Z");
    render(<ReviewIndicator />);
    await flush();
    expect(screen.queryByTestId("unseen-dot")).toBeNull();
    summary = { pending: 2, latestSubmittedAt: "2026-01-03T00:00:00.000Z" }; // something newer arrives
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(screen.getByTestId("unseen-dot")).toBeTruthy();
  });

  it("markReviewsSeen with nothing to mark writes nothing", () => {
    markReviewsSeen(null);
    expect(window.localStorage.length).toBe(0);
  });

  it("works when storage throws on read and on write: the count still shows, the dot never does", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    summary = { pending: 2, latestSubmittedAt: "2026-01-02T00:00:00.000Z" };
    render(<ReviewIndicator />);
    await flush();
    expect(screen.getByRole("link", { name: /Reviews, 2 waiting/ })).toBeTruthy();
    expect(() => markReviewsSeen("2026-01-02T00:00:00.000Z")).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});
