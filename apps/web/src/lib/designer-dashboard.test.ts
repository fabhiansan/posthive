import { describe, expect, it } from "vitest";
import {
  activityLines,
  activityTime,
  designSubtitle,
  formatLabel,
  publishLines,
  queueFooter,
  templatePillars,
  templatesLine,
  templateTotals,
  versionLabel,
  waitingLabel,
  type ApiDesignActivity,
  type PostMedia,
} from "./designer-dashboard";

// Tuesday 17 Nov 2026, 12:00 in WIB
const NOW = new Date("2026-11-17T05:00:00Z");
const media = (patch: Partial<PostMedia> = {}): PostMedia => ({ images: 0, video: false, mediaType: null, youtubeType: null, ...patch });

describe("formatLabel", () => {
  it("names a carousel with its slides, and a single picture", () => {
    expect(formatLabel(media({ images: 5 }))).toBe("Carousel · 5 slides");
    expect(formatLabel(media({ images: 2 }))).toBe("Carousel · 2 slides");
    expect(formatLabel(media({ images: 1 }))).toBe("Single image");
  });

  it("a post with no media says so", () => {
    expect(formatLabel(media())).toBe("No media yet");
  });

  it("a Reel, a Story, a video and a YouTube post are named by what they are, before the pictures", () => {
    expect(formatLabel(media({ mediaType: "reel", images: 3 }))).toBe("Reel");
    expect(formatLabel(media({ mediaType: "story" }))).toBe("Story");
    expect(formatLabel(media({ youtubeType: "short", video: true }))).toBe("YouTube Short");
    expect(formatLabel(media({ youtubeType: "video" }))).toBe("YouTube video");
    expect(formatLabel(media({ video: true }))).toBe("Video");
  });
});

describe("versionLabel", () => {
  it("the first send is v1; every later send is a revision round", () => {
    expect(versionLabel(1)).toBe("v1 · first submission");
    expect(versionLabel(2)).toBe("v2 · revision round 2");
    expect(versionLabel(4)).toBe("v4 · revision round 4");
  });

  it("a post whose sends were never counted is still v1", () => {
    expect(versionLabel(0)).toBe("v1 · first submission");
  });
});

describe("waitingLabel", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const H = 3600_000;

  it("counts hours under a day and days after", () => {
    expect(waitingLabel(ago(5 * H), NOW).text).toBe("5 h");
    expect(waitingLabel(ago(23 * H), NOW).text).toBe("23 h");
    expect(waitingLabel(ago(24 * H), NOW).text).toBe("1 d");
    expect(waitingLabel(ago(3 * 24 * H + 5 * H), NOW).text).toBe("3 d");
  });

  it("under an hour, and a time in the future (a clock that is a little off), read as less than an hour", () => {
    expect(waitingLabel(ago(10 * 60_000), NOW).text).toBe("< 1 h");
    expect(waitingLabel(ago(-5 * 60_000), NOW).text).toBe("< 1 h");
  });

  it("is late from two days: 1 d is not, 2 d is", () => {
    expect(waitingLabel(ago(47 * H), NOW)).toEqual({ text: "1 d", late: false });
    expect(waitingLabel(ago(48 * H), NOW)).toEqual({ text: "2 d", late: true });
    expect(waitingLabel(ago(5 * H), NOW).late).toBe(false);
  });

  it("nothing recorded, or a broken date: a dash, not late", () => {
    expect(waitingLabel(null, NOW)).toEqual({ text: "—", late: false });
    expect(waitingLabel("not a date", NOW)).toEqual({ text: "—", late: false });
  });
});

describe("publishLines", () => {
  const lines = (iso: string | null) => publishLines(iso, NOW);

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

  it("a post with no date, or a broken one, has no lines", () => {
    expect(lines(null)).toBeNull();
    expect(lines("not a date")).toBeNull();
  });
});

describe("queueFooter", () => {
  it("says how many of those waiting are shown, and what else is going on", () => {
    expect(queueFooter(5, 9, 3, 46)).toBe("Showing 5 of 9 designs waiting · 3 sent back for revision · 46 approved this quarter");
  });

  it("one design", () => {
    expect(queueFooter(1, 1, 0, 0)).toBe("Showing 1 of 1 design waiting · 0 sent back for revision · 0 approved this quarter");
  });

  it("never claims fewer waiting than are shown", () => {
    expect(queueFooter(5, 3, 0, 0)).toContain("Showing 5 of 5 designs");
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
    kind: "submitted",
    at: "2026-11-17T02:12:00Z",
    by: "Putri Anggraini",
    mine: false,
    title: "When Environmental Data Leads to Enforcement",
    pillar: null,
    ...patch,
  });

  it("a send: who sent which design, and when", () => {
    expect(activityLines(event({}), NOW)).toEqual({
      title: "New design submitted by Marketing",
      detail: "Putri A. submitted “When Environmental Data Leads to Enforcement” · 09:12",
    });
  });

  it("an approval by the person looking says You; by someone else, their name", () => {
    expect(activityLines(event({ kind: "approved", mine: true, at: "2026-11-17T01:55:00Z", title: "Behind the Scenes" }), NOW)).toEqual({
      title: "Design approved",
      detail: "You approved “Behind the Scenes” · 08:55",
    });
    expect(activityLines(event({ kind: "approved", by: "Dewi Kusuma" }), NOW).detail).toContain("Dewi K. approved");
  });

  it("a revision request", () => {
    expect(activityLines(event({ kind: "revision", mine: true, at: "2026-11-16T09:40:00Z", title: "Backcasting" }), NOW)).toEqual({
      title: "Revision requested",
      detail: "You asked for changes on “Backcasting” · yesterday 16:40",
    });
  });

  it("a template: where it was added, and a template with no pillar says so", () => {
    const t = event({ kind: "template", title: "Insight Carousel v3", pillar: "Educational", at: "2026-11-16T07:10:00Z" });
    expect(activityLines(t, NOW)).toEqual({ title: "New template uploaded", detail: "“Insight Carousel v3” added to Educational · yesterday 14:10" });
    expect(activityLines({ ...t, pillar: null }, NOW).detail).toContain("added to No pillar");
  });

  it("a person who is gone is called Someone, not undefined", () => {
    expect(activityLines(event({ kind: "approved", by: null }), NOW).detail).toContain("Someone approved");
  });
});

describe("templates", () => {
  const list = [
    { pillar: "Educational", published: true },
    { pillar: "Educational", published: false },
    { pillar: "Promotional", published: true },
  ];

  it("totals: published is seen by Marketing, a draft is not", () => {
    expect(templateTotals(list)).toEqual({ total: 3, published: 2, draft: 1 });
    expect(templateTotals([])).toEqual({ total: 0, published: 0, draft: 0 });
  });

  it("one row for each of the four pillars, in order, even with no templates", () => {
    expect(templatePillars(list).map((r) => [r.pillar, r.total, r.published])).toEqual([
      ["Promotional", 1, 1],
      ["Educational", 2, 1],
      ["Entertainment", 0, 0],
      ["Conversational", 0, 0],
    ]);
  });

  it("No pillar is a row only when a template has no pillar", () => {
    expect(templatePillars(list).map((r) => r.pillar)).not.toContain("No pillar");
    const withRest = templatePillars([...list, { pillar: null, published: true }]);
    expect(withRest[withRest.length - 1]).toEqual({ pillar: "No pillar", total: 1, published: 1 });
  });

  it("a pillar the app does not know goes to No pillar instead of vanishing", () => {
    expect(templatePillars([{ pillar: "Seasonal", published: false }]).at(-1)).toEqual({ pillar: "No pillar", total: 1, published: 0 });
  });

  it("the line of a row", () => {
    expect(templatesLine({ pillar: "Educational", total: 6, published: 5 })).toBe("6 templates · 5 published");
    expect(templatesLine({ pillar: "Educational", total: 1, published: 0 })).toBe("1 template · 0 published");
    expect(templatesLine({ pillar: "Product", total: 0, published: 0 })).toBe("No templates yet");
  });
});

describe("designSubtitle", () => {
  it("how many designs wait and how many templates are still in Draft", () => {
    expect(designSubtitle(8, 2)).toBe("8 designs from the Marketing Team are waiting for your review · 2 templates still in Draft.");
  });

  it("one design, one template", () => {
    expect(designSubtitle(1, 1)).toBe("1 design from the Marketing Team is waiting for your review · 1 template still in Draft.");
  });

  it("no draft leaves the second part out; nothing waiting says so", () => {
    expect(designSubtitle(3, 0)).toBe("3 designs from the Marketing Team are waiting for your review.");
    expect(designSubtitle(0, 0)).toBe("No designs from the Marketing Team are waiting for your review.");
    expect(designSubtitle(0, 2)).toBe("No designs from the Marketing Team are waiting for your review · 2 templates still in Draft.");
  });
});
