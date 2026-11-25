import { describe, expect, it } from "vitest";
import { activityLines, activityTime, dueLines, templatePillars, templatesLine, templateTotals, type ApiDesignActivity } from "./designer-dashboard";

// Tuesday 17 Nov 2026, 12:00 in WIB
const NOW = new Date("2026-11-17T05:00:00Z");

describe("dueLines", () => {
  const lines = (iso: string | null) => dueLines(iso, NOW);

  it("the day over the time and how far away it is", () => {
    expect(lines("2026-11-21T02:00:00Z")).toEqual({ day: "Sat 21 Nov", time: "09:00 · in 4 days", urgent: false });
    expect(lines("2026-11-18T09:00:00Z")).toMatchObject({ day: "Wed 18 Nov", time: "16:00 · tomorrow" });
  });

  it("today and tomorrow are urgent, and so is a date that has passed", () => {
    expect(lines("2026-11-17T09:00:00Z")).toEqual({ day: "Tue 17 Nov", time: "16:00 · today", urgent: true });
    expect(lines("2026-11-18T07:00:00Z")).toMatchObject({ time: "14:00 · tomorrow", urgent: true });
    expect(lines("2026-11-16T07:00:00Z")).toEqual({ day: "Mon 16 Nov", time: "14:00 · overdue", urgent: true });
  });

  it("counts calendar days in WIB: 17:00 UTC on the 17th is already the 18th in Jakarta, so it is tomorrow", () => {
    expect(lines("2026-11-17T17:30:00Z")).toMatchObject({ day: "Wed 18 Nov", time: "00:30 · tomorrow", urgent: true });
    expect(lines("2026-11-19T17:30:00Z")).toMatchObject({ time: "00:30 · in 3 days", urgent: false });
  });

  it("a task with no deadline, or a broken one, has no lines", () => {
    expect(lines(null)).toBeNull();
    expect(lines("not a date")).toBeNull();
  });
});

describe("activityTime", () => {
  it("today is the time, yesterday says so, older is the day", () => {
    expect(activityTime("2026-11-17T02:12:00Z", NOW)).toBe("09:12");
    expect(activityTime("2026-11-16T09:40:00Z", NOW)).toBe("yesterday 16:40");
    expect(activityTime("2026-11-11T07:22:00Z", NOW)).toBe("11 Nov 14:22");
  });

  it("goes by the WIB day: 23:30 on the 16th in Jakarta is yesterday, 00:30 on the 17th is today", () => {
    expect(activityTime("2026-11-16T16:30:00Z", NOW)).toBe("yesterday 23:30");
    expect(activityTime("2026-11-16T17:30:00Z", NOW)).toBe("00:30");
  });

  it("a broken date is empty", () => {
    expect(activityTime("nope", NOW)).toBe("");
  });
});

describe("activityLines", () => {
  const event = (patch: Partial<ApiDesignActivity>): ApiDesignActivity => ({
    kind: "assigned",
    at: "2026-11-17T02:12:00Z",
    by: "Rina Anggraini",
    mine: false,
    title: "When Environmental Data Leads to Enforcement",
    pillar: null,
    ...patch,
  });

  it("a new task: who assigned which post, and when", () => {
    expect(activityLines(event({}), NOW)).toEqual({
      title: "New task assigned",
      detail: "Rina A. assigned “When Environmental Data Leads to Enforcement” to you · 09:12",
    });
  });

  it("a person who is gone is called Marketing, not undefined", () => {
    expect(activityLines(event({ by: null }), NOW).detail).toContain("Marketing assigned");
  });

  it("a design the designer sent", () => {
    expect(activityLines(event({ kind: "sent", mine: true, at: "2026-11-16T09:40:00Z", title: "Backcasting" }), NOW)).toEqual({
      title: "Design sent to Marketing",
      detail: "You sent the Figma link for “Backcasting” · yesterday 16:40",
    });
  });

  it("a template: where it was added, and a template with no pillar says so", () => {
    const t = event({ kind: "template", title: "Insight Carousel v3", pillar: "Educational", at: "2026-11-16T07:10:00Z" });
    expect(activityLines(t, NOW)).toEqual({ title: "New template uploaded", detail: "“Insight Carousel v3” added to Educational · yesterday 14:10" });
    expect(activityLines({ ...t, pillar: null }, NOW).detail).toContain("added to No pillar");
  });
});

describe("templates", () => {
  const t = (pillar: string | null, published: boolean) => ({ pillar, published });

  it("totals: published is seen by Marketing, a draft is not", () => {
    expect(templateTotals([t("Educational", true), t("Promotional", false), t("Promotional", true)])).toEqual({ total: 3, published: 2, draft: 1 });
    expect(templateTotals([])).toEqual({ total: 0, published: 0, draft: 0 });
  });

  it("one row for each of the four pillars, in order, even with no templates", () => {
    const rows = templatePillars([]);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.total === 0)).toBe(true);
  });

  it("No pillar is a row only when a template has no pillar", () => {
    expect(templatePillars([t(null, true)]).at(-1)).toEqual({ pillar: "No pillar", total: 1, published: 1 });
    expect(templatePillars([]).some((r) => r.pillar === "No pillar")).toBe(false);
  });

  it("a pillar the app does not know goes to No pillar instead of vanishing", () => {
    expect(templatePillars([t("Mystery", false)]).at(-1)).toEqual({ pillar: "No pillar", total: 1, published: 0 });
  });

  it("the line of a row", () => {
    expect(templatesLine({ pillar: "Educational", total: 6, published: 5 })).toBe("6 templates · 5 published");
    expect(templatesLine({ pillar: "Educational", total: 1, published: 0 })).toBe("1 template · 0 published");
    expect(templatesLine({ pillar: "Educational", total: 0, published: 0 })).toBe("No templates yet");
  });
});
