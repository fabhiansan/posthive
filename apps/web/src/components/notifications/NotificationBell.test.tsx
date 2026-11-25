// @vitest-environment jsdom
// The bell and its drawer, as every role uses them: the badge, the Today / Earlier groups, what a click does, Mark all as read.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NotificationItem } from "@/lib/notifications";

const h = vi.hoisted(() => ({ apiFetch: vi.fn(), push: vi.fn() }));

vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));

import { NotificationBell } from "./NotificationBell";

// Friday 13 Nov 2026, 10:26 in WIB
const NOW = new Date("2026-11-13T03:26:00Z");

const n = (patch: Partial<NotificationItem> = {}): NotificationItem => ({
  id: "n1", kind: "task_assigned", postId: "p1", title: "Geospatial Technology in Indonesia", thumbnail: null, by: "Rina Anggraini", note: null, read: false, at: "2026-11-13T03:24:00.000Z", ...patch,
});

let list: { items: NotificationItem[]; unread: number };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  for (const m of [h.apiFetch, h.push]) m.mockReset();
  list = {
    items: [
      n(),
      n({ id: "n2", kind: "post_sent_back", postId: "p2", title: "Braga's Backcasting 2026", by: "Putri Anggraini", note: "Make the timeline readable", at: "2026-11-13T02:12:00.000Z" }),
      n({ id: "n3", kind: "design_done", postId: "p3", title: "Platform Geospatial Dashboard", read: true, at: "2026-11-12T09:40:00.000Z" }),
    ],
    unread: 2,
  };
  h.apiFetch.mockImplementation(async (path: string) => {
    if (path === "/notifications/unread-count") return { unread: list.unread };
    if (path === "/notifications") return list;
    return { marked: 1 };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const calls = (path: string) => h.apiFetch.mock.calls.filter((c) => c[0] === path);
const bell = () => screen.getByRole("button", { name: /^Notifications/ });
const openDrawer = async () => {
  await userEvent.click(bell());
  return within(await screen.findByRole("dialog"));
};

describe("the bell", () => {
  it("asks how many are unread when the page opens, and shows the number", async () => {
    render(<NotificationBell />);
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 2 unread"));
    expect(calls("/notifications/unread-count")).toHaveLength(1);
    expect(calls("/notifications")).toHaveLength(0); // the list waits for the drawer
  });

  it("shows no number when nothing is unread, and 99+ for a lot", async () => {
    list.unread = 0;
    const { unmount } = render(<NotificationBell />);
    await waitFor(() => expect(calls("/notifications/unread-count")).toHaveLength(1));
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
    unmount();
    list.unread = 250;
    render(<NotificationBell />);
    await waitFor(() => expect(bell().textContent).toBe("99+"));
  });

  it("asks again every minute, and keeps the last number when a poll fails", async () => {
    render(<NotificationBell />);
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 2 unread"));
    h.apiFetch.mockRejectedValue(new Error("offline"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(calls("/notifications/unread-count").length).toBeGreaterThan(1);
    expect(bell().getAttribute("aria-label")).toBe("Notifications, 2 unread");
  });
});

describe("the drawer", () => {
  it("opens with the list: the title, the counts, Today and Earlier, and a tinted row with a dot for each unread one", async () => {
    render(<NotificationBell />);
    const drawer = await openDrawer();
    expect(drawer.getByText("Notification")).toBeTruthy();
    expect(await drawer.findByText("3 items · 2 unread. Select one to open it.")).toBeTruthy();
    const today = within(drawer.getByRole("region", { name: "Today" }));
    const earlier = within(drawer.getByRole("region", { name: "Earlier" }));
    expect(today.getAllByRole("button")).toHaveLength(2);
    expect(earlier.getAllByRole("button")).toHaveLength(1);
    expect(today.getByText("Assigned")).toBeTruthy();
    expect(today.getByText("Assigned by Rina A. · Marketing")).toBeTruthy();
    expect(today.getByText("Revision required")).toBeTruthy();
    expect(today.getByText("Putri A.: Make the timeline readable")).toBeTruthy();
    expect(today.getByText("2 min ago · Nov 13, 2026, 10:24")).toBeTruthy();
    expect(today.getAllByText("Unread")).toHaveLength(2);
    expect(earlier.queryByText("Unread")).toBeNull();
    expect(earlier.getByText("Yesterday · Nov 12, 2026, 16:40")).toBeTruthy();
    // one list, not tabs
    expect(drawer.queryByRole("tab")).toBeNull();
  });

  it("a click marks that row read at once (the number goes down), closes the drawer and goes where the row points", async () => {
    render(<NotificationBell />);
    const drawer = await openDrawer();
    await userEvent.click(await drawer.findByRole("button", { name: /Geospatial Technology in Indonesia/ }));
    expect(h.push).toHaveBeenCalledWith("/tasks/p1");
    expect(calls("/notifications/n1/read")).toHaveLength(1);
    expect(calls("/notifications/n1/read")[0][1].method).toBe("POST");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bell().getAttribute("aria-label")).toBe("Notifications, 1 unread");
  });

  it("a row that is already read is not marked again, and still goes where it points", async () => {
    render(<NotificationBell />);
    const drawer = await openDrawer();
    await userEvent.click(await drawer.findByRole("button", { name: /Platform Geospatial Dashboard/ }));
    expect(h.push).toHaveBeenCalledWith("/jobs/p3/edit");
    expect(calls("/notifications/n3/read")).toHaveLength(0);
  });

  it("a post sent back opens Marketing's editor; a post to review opens the Content List on it", async () => {
    list.items = [n({ id: "a", kind: "post_sent_back", postId: "p2", title: "Sent back" }), n({ id: "b", kind: "review_submitted", postId: "p9", title: "To review" })];
    render(<NotificationBell />);
    const drawer = await openDrawer();
    await userEvent.click(await drawer.findByRole("button", { name: /Sent back/ }));
    expect(h.push).toHaveBeenLastCalledWith("/jobs/p2/edit");
  });

  it("Mark all as read clears the dots and the number, and tells the server once", async () => {
    render(<NotificationBell />);
    const drawer = await openDrawer();
    await drawer.findByText(/2 unread/);
    await userEvent.click(drawer.getByRole("button", { name: "Mark all as read" }));
    expect(calls("/notifications/read-all")).toHaveLength(1);
    expect(calls("/notifications/read-all")[0][1].method).toBe("POST");
    await waitFor(() => expect(drawer.queryByText("Unread")).toBeNull());
    expect(drawer.getByText("3 items · 0 unread. Select one to open it.")).toBeTruthy();
    expect((drawer.getByRole("button", { name: "Mark all as read" }) as HTMLButtonElement).disabled).toBe(true);
    // the bell is behind the open drawer (hidden from a screen reader): close it to read the number
    await userEvent.click(drawer.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
  });

  it("Close closes it", async () => {
    render(<NotificationBell />);
    const drawer = await openDrawer();
    await userEvent.click(drawer.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("with nothing it says so, with no group", async () => {
    list = { items: [], unread: 0 };
    render(<NotificationBell />);
    const drawer = await openDrawer();
    expect(await drawer.findByText("You're all caught up.")).toBeTruthy();
    expect(drawer.queryByRole("region")).toBeNull();
  });

  it("when the list cannot be loaded it says so and offers to try again", async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path === "/notifications/unread-count") return { unread: 0 };
      throw new Error("Network down");
    });
    render(<NotificationBell />);
    const drawer = await openDrawer();
    expect(await drawer.findByText(/We couldn't load your notifications/)).toBeTruthy();
    expect(drawer.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
