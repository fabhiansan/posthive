import { describe, expect, it } from "vitest";
import { dashboardSubtitle, dueIn, dueParts, formatOf, historyLine, linkState, taskBanner, tasksFooter, tasksSubtitle, type FigmaCheck } from "./design-tasks";

// Tuesday 17 Nov 2026, 12:00 in WIB
const NOW = new Date("2026-11-17T05:00:00Z");
const LINK = "https://www.figma.com/design/Xk3aPq/env-enforcement";

describe("linkState: the line under the Figma link field, and whether Mark as done may be pressed", () => {
  const state = (raw: string, checking = false, checked: FigmaCheck | null = null) => linkState(raw, checking, checked);

  it("nothing pasted: no message, and Mark as done is off", () => {
    expect(state("")).toEqual({ tone: "idle", message: "", canMarkDone: false });
    expect(state("   ")).toEqual({ tone: "idle", message: "", canMarkDone: false });
  });

  it("a link that is not a Figma file is an error with no request needed, and Mark as done stays off", () => {
    for (const bad of ["not a link", "https://example.com/design/x", "http://www.figma.com/design/x", "https://www.figma.com/pricing"]) {
      const s = state(bad);
      expect(s.tone, bad).toBe("error");
      expect(s.canMarkDone, bad).toBe(false);
      expect(s.message, bad).toMatch(/Use a Figma link/);
    }
  });

  it("a Figma link that has not been asked about yet, or is being asked about, says it is checking and is off", () => {
    expect(state(LINK)).toMatchObject({ tone: "checking", canMarkDone: false });
    expect(state(LINK, true, { state: "valid", title: "Old answer" })).toMatchObject({ tone: "checking", canMarkDone: false });
  });

  it("valid turns Mark as done on and names the file", () => {
    expect(state(LINK, false, { state: "valid", title: "Braga Backcasting" })).toEqual({ tone: "valid", message: "Link valid · Braga Backcasting", canMarkDone: true });
    expect(state(LINK, false, { state: "valid", title: null })).toMatchObject({ tone: "valid", canMarkDone: true });
  });

  it("private (or mistyped) keeps it off and says how to share the file", () => {
    const s = state(LINK, false, { state: "private" });
    expect(s).toMatchObject({ tone: "error", canMarkDone: false });
    expect(s.message).toMatch(/Anyone with the link/);
  });

  it("Figma that could not be asked warns but does not block: the link is not proven wrong", () => {
    expect(state(LINK, false, { state: "unreachable" })).toMatchObject({ tone: "warn", canMarkDone: true });
  });

  it("surrounding spaces do not matter", () => {
    expect(state(`  ${LINK}  `, false, { state: "valid", title: "T" }).canMarkDone).toBe(true);
  });
});

describe("dueIn", () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  const H = 3600_000;

  it("days and hours ahead, and urgent only under a day", () => {
    expect(dueIn(at(3 * 24 * H + 2 * H), "assigned", NOW)).toEqual({ text: "in 3 d", urgent: false });
    expect(dueIn(at(5 * H), "progress", NOW)).toEqual({ text: "in 5 h", urgent: true });
    expect(dueIn(at(24 * H), "assigned", NOW)).toEqual({ text: "in 1 d", urgent: false });
    expect(dueIn(at(10 * 60_000), "assigned", NOW)).toEqual({ text: "< 1 h", urgent: true });
  });

  it("past: overdue, and urgent", () => {
    expect(dueIn(at(-2 * 24 * H - H), "assigned", NOW)).toEqual({ text: "overdue 2 d", urgent: true });
    expect(dueIn(at(-3 * H), "assigned", NOW)).toEqual({ text: "overdue 3 h", urgent: true });
  });

  it("a task with no deadline says so, and a done task has nothing to wait for", () => {
    expect(dueIn(null, "assigned", NOW)).toEqual({ text: "No deadline", urgent: false });
    expect(dueIn(at(-5 * H), "done", NOW)).toEqual({ text: "—", urgent: false });
    expect(dueIn("not a date", "assigned", NOW)).toEqual({ text: "No deadline", urgent: false });
  });
});

describe("dueParts and formatOf", () => {
  it("a date and a WIB time, or nothing", () => {
    expect(dueParts("2026-03-04T10:00:00Z")).toEqual({ day: "Wed, 4 Mar 2026", time: "17:00 WIB" });
    expect(dueParts(null)).toBeNull();
    expect(dueParts("nope")).toBeNull();
  });

  it("the format Marketing picked, or a dash", () => {
    expect(formatOf({ format: "carousel" })).toBe("Carousel");
    expect(formatOf({ format: "single" })).toBe("Single image");
    expect(formatOf({ format: null })).toBe("—");
  });
});

describe("the words of the pages", () => {
  it("the My Task subtitle counts the open tasks and the done ones waiting for Marketing, and says who approves", () => {
    expect(tasksSubtitle({ assigned: 2, progress: 1, done: 3, waiting: 2 })).toBe(
      "3 posts from Marketing are waiting for your design · 2 designs done and waiting for Marketing · Only Admin approves content.",
    );
    expect(tasksSubtitle({ assigned: 1, progress: 0, done: 0, waiting: 1 })).toBe(
      "1 post from Marketing is waiting for your design · 1 design done and waiting for Marketing · Only Admin approves content.",
    );
    expect(tasksSubtitle({ assigned: 0, progress: 0, done: 0, waiting: 0 })).toMatch(/^No posts from Marketing are waiting for your design/);
  });

  it("the dashboard subtitle: how many are assigned, how many started, how many templates are in Draft", () => {
    expect(dashboardSubtitle({ assigned: 3, progress: 2, done: 0, waiting: 0 }, 2)).toBe("5 posts from Marketing are assigned to you · 2 in progress · 2 templates still in Draft.");
    expect(dashboardSubtitle({ assigned: 1, progress: 0, done: 0, waiting: 0 }, 0)).toBe("1 post from Marketing is assigned to you.");
    expect(dashboardSubtitle({ assigned: 0, progress: 0, done: 4, waiting: 0 }, 1)).toBe("No posts from Marketing are assigned to you · 1 template still in Draft.");
  });

  it("the footer of the table", () => {
    expect(tasksFooter(5, 5, 2)).toBe("Showing 5 of 5 tasks assigned to you · 2 done are waiting for Marketing");
    expect(tasksFooter(1, 1, 1)).toBe("Showing 1 of 1 task assigned to you · 1 done is waiting for Marketing");
    expect(tasksFooter(3, 3, 0)).toBe("Showing 3 of 3 tasks assigned to you");
  });

  it("the banner on a task page follows where the task stands", () => {
    expect(taskBanner({ status: "assigned", figmaUrl: null, designerNote: null })).toMatchObject({ tone: "info", title: "New task" });
    expect(taskBanner({ status: "progress", figmaUrl: LINK, designerNote: null })).toMatchObject({ tone: "info", title: "Draft saved" });
    expect(taskBanner({ status: "done", figmaUrl: LINK, designerNote: null })).toMatchObject({ tone: "success", title: "Sent to Marketing" });
  });

  it("a line of the history", () => {
    expect(historyLine("sent", "Rina Anggraini")).toBe("Design request sent by Rina A.");
    expect(historyLine("sent", null)).toBe("Design request sent by Marketing");
    expect(historyLine("draft", null)).toBe("Draft saved");
    expect(historyLine("done", null)).toBe("Sent to Marketing");
  });
});
