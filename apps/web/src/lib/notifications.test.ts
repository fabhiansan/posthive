import { describe, expect, it } from "vitest";
import { badgeText, drawerSubtitle, groupNotifications, notificationHref, notificationTime, notificationWords, type NotificationItem } from "./notifications";

// Friday 13 Nov 2026, 10:26 in WIB
const NOW = new Date("2026-11-13T03:26:00Z");

const item = (patch: Partial<NotificationItem> = {}): NotificationItem => ({
  id: "n1", kind: "task_assigned", postId: "p1", title: "Geospatial Technology", thumbnail: null, by: "Rina Anggraini", note: null, read: false, at: "2026-11-13T03:24:00.000Z", ...patch,
});

describe("notificationWords", () => {
  it("a new task says who assigned it", () => {
    expect(notificationWords(item())).toEqual({ pill: "Assigned", tone: "neutral", line: "Assigned by Rina A. · Marketing" });
  });

  it("a design that came back, an approval and a post to approve each have their own pill and line", () => {
    expect(notificationWords(item({ kind: "design_done", by: "Dewi Kusuma" }))).toEqual({ pill: "Design done", tone: "success", line: "Dewi K. sent the Figma link" });
    expect(notificationWords(item({ kind: "post_approved" })).pill).toBe("Approved");
    expect(notificationWords(item({ kind: "review_submitted" }))).toMatchObject({ pill: "In review", tone: "info" });
    expect(notificationWords(item({ kind: "post_failed" }))).toMatchObject({ pill: "Failed", tone: "danger", line: "The post could not be published" });
    expect(notificationWords(item({ kind: "task_cancelled" })).pill).toBe("Cancelled");
  });

  it("a post sent back carries the reviewer's note when there is one", () => {
    expect(notificationWords(item({ kind: "post_sent_back", by: "Putri Anggraini", note: "Make the timeline readable" })).line).toBe("Putri A.: Make the timeline readable");
    expect(notificationWords(item({ kind: "post_sent_back", note: null })).line).toBe("Rina A. sent the post back");
  });

  it("a person who is gone is Someone, and a kind a newer server sends is shown plainly instead of dropped", () => {
    expect(notificationWords(item({ kind: "design_done", by: null })).line).toBe("Someone sent the Figma link");
    expect(notificationWords(item({ kind: "something_new" }))).toEqual({ pill: "Update", tone: "neutral", line: "Something changed on this post" });
  });
});

describe("notificationHref", () => {
  it("a task opens the designer's task, a cancelled one the list", () => {
    expect(notificationHref({ kind: "task_assigned", postId: "p1" })).toBe("/tasks/p1");
    expect(notificationHref({ kind: "task_cancelled", postId: "p1" })).toBe("/tasks");
  });

  it("a design that came back and a post sent back open Marketing's editor", () => {
    expect(notificationHref({ kind: "design_done", postId: "p1" })).toBe("/jobs/p1/edit");
    expect(notificationHref({ kind: "post_sent_back", postId: "p1" })).toBe("/jobs/p1/edit");
  });

  it("a post to review, an approval and a failure open the post in the Content List", () => {
    for (const kind of ["review_submitted", "post_approved", "post_failed", "something_new"]) expect(notificationHref({ kind, postId: "p1" }), kind).toBe("/jobs?open=p1");
  });

  it("a post that is gone has nowhere to go, except a cancelled task which only needs the list", () => {
    expect(notificationHref({ kind: "design_done", postId: null })).toBeNull();
    expect(notificationHref({ kind: "task_cancelled", postId: null })).toBe("/tasks");
  });

  it("the id is escaped", () => {
    expect(notificationHref({ kind: "task_assigned", postId: "a/b?c" })).toBe("/tasks/a%2Fb%3Fc");
  });
});

describe("notificationTime", () => {
  it("minutes and hours ago on the same WIB day, with the moment", () => {
    expect(notificationTime("2026-11-13T03:24:00.000Z", NOW)).toBe("2 min ago · Nov 13, 2026, 10:24");
    expect(notificationTime("2026-11-13T02:26:00.000Z", NOW)).toBe("1 h ago · Nov 13, 2026, 09:26");
    expect(notificationTime("2026-11-13T03:25:40.000Z", NOW)).toMatch(/^Just now/);
  });

  it("yesterday, and days ago, by the WIB calendar: 23:30 on the 12th in Jakarta is yesterday", () => {
    expect(notificationTime("2026-11-12T09:40:00.000Z", NOW)).toBe("Yesterday · Nov 12, 2026, 16:40");
    expect(notificationTime("2026-11-12T16:30:00.000Z", NOW)).toBe("Yesterday · Nov 12, 2026, 23:30");
    expect(notificationTime("2026-11-12T17:30:00.000Z", NOW)).toBe("9 h ago · Nov 13, 2026, 00:30"); // already the 13th in Jakarta
    expect(notificationTime("2026-11-09T09:40:00.000Z", NOW)).toMatch(/^4 d ago/);
  });

  it("a broken date is empty", () => {
    expect(notificationTime("nope", NOW)).toBe("");
  });
});

describe("groupNotifications", () => {
  it("splits the WIB day of now from everything before it, keeping the order the server sent", () => {
    const list = [
      item({ id: "a", at: "2026-11-13T03:24:00.000Z" }),
      item({ id: "b", at: "2026-11-12T17:30:00.000Z" }), // 00:30 on the 13th in Jakarta: today
      item({ id: "c", at: "2026-11-12T09:40:00.000Z" }),
      item({ id: "d", at: "2026-10-01T09:40:00.000Z" }),
    ];
    const { today, earlier } = groupNotifications(list, NOW);
    expect(today.map((n) => n.id)).toEqual(["a", "b"]);
    expect(earlier.map((n) => n.id)).toEqual(["c", "d"]);
  });

  it("nothing is two empty groups", () => {
    expect(groupNotifications([], NOW)).toEqual({ today: [], earlier: [] });
  });
});

describe("the words of the drawer and the bell", () => {
  it("the subtitle counts the items and the unread ones", () => {
    expect(drawerSubtitle(4, 2)).toBe("4 items · 2 unread. Select one to open it.");
    expect(drawerSubtitle(1, 0)).toBe("1 item · 0 unread. Select one to open it.");
    expect(drawerSubtitle(0, 0)).toMatch(/^Nothing yet/);
  });

  it("the badge is empty at zero and stops at 99+", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(-1)).toBe("");
    expect(badgeText(7)).toBe("7");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(100)).toBe("99+");
  });
});
