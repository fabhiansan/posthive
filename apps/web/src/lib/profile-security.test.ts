import { describe, expect, it } from "vitest";
import { activityLines, lastSeenLabel, lastSignInLine, signInTime, type ApiActivityRow, type ApiSignIn } from "./profile-security";

// Tuesday 17 Nov 2026, 12:00 in WIB
const NOW = new Date("2026-11-17T05:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

describe("lastSeenLabel", () => {
  it("the device in use, or one that moved a moment ago, is active now", () => {
    expect(lastSeenLabel(ago(3 * D), true, NOW)).toBe("active now");
    expect(lastSeenLabel(ago(2 * MIN), false, NOW)).toBe("active now");
  });

  it("then minutes, hours and days, singular and plural", () => {
    expect(lastSeenLabel(ago(6 * MIN), false, NOW)).toBe("last active 6 minutes ago");
    expect(lastSeenLabel(ago(H), false, NOW)).toBe("last active 1 hour ago");
    expect(lastSeenLabel(ago(2 * H), false, NOW)).toBe("last active 2 hours ago");
    expect(lastSeenLabel(ago(D), false, NOW)).toBe("last active 1 day ago");
    expect(lastSeenLabel(ago(3 * D), false, NOW)).toBe("last active 3 days ago");
  });

  it("a clock a little ahead of the server, or a broken date, does not say a negative time", () => {
    expect(lastSeenLabel(new Date(NOW.getTime() + 5 * MIN).toISOString(), false, NOW)).toBe("active now");
    expect(lastSeenLabel("nope", false, NOW)).toBe("");
  });
});

describe("signInTime", () => {
  it("today and yesterday say so; older is the date; all in WIB", () => {
    expect(signInTime("2026-11-17T01:12:00Z", NOW)).toBe("Today, 08:12 WIB");
    expect(signInTime("2026-11-16T12:40:00Z", NOW)).toBe("Yesterday, 19:40 WIB");
    expect(signInTime("2026-11-10T15:05:00Z", NOW)).toBe("10 Nov 2026, 22:05 WIB");
  });

  it("goes by the WIB day: 17:30 UTC on the 16th is already the 17th in Jakarta", () => {
    expect(signInTime("2026-11-16T17:30:00Z", NOW)).toBe("Today, 00:30 WIB");
    expect(signInTime("2026-11-16T16:30:00Z", NOW)).toBe("Yesterday, 23:30 WIB");
  });

  it("a broken date is empty", () => {
    expect(signInTime("nope", NOW)).toBe("");
  });
});

describe("lastSignInLine", () => {
  const ok = (at: string, device = "Chrome on macOS"): ApiSignIn => ({ id: at, at, device, failure: null });
  const bad = (at: string): ApiSignIn => ({ id: at, at, device: "Firefox on Linux", failure: "Wrong password" });

  it("the newest sign-in that worked, with the device", () => {
    expect(lastSignInLine([ok("2026-11-17T01:12:00Z")], NOW)).toBe("Last sign-in today, 08:12 WIB · Chrome on macOS");
    expect(lastSignInLine([ok("2026-11-16T12:40:00Z", "Safari on iOS")], NOW)).toBe("Last sign-in yesterday, 19:40 WIB · Safari on iOS");
    expect(lastSignInLine([ok("2026-11-10T15:05:00Z")], NOW)).toBe("Last sign-in 10 Nov 2026, 22:05 WIB · Chrome on macOS");
  });

  it("a wrong password is not a sign-in: it is skipped", () => {
    expect(lastSignInLine([bad("2026-11-17T04:00:00Z"), ok("2026-11-17T01:12:00Z")], NOW)).toContain("08:12 WIB");
  });

  it("nothing that worked, or nothing at all: no line", () => {
    expect(lastSignInLine([], NOW)).toBeUndefined();
    expect(lastSignInLine([bad("2026-11-17T04:00:00Z")], NOW)).toBeUndefined();
  });
});

describe("activityLines", () => {
  const rows = (...r: ApiActivityRow[]) => activityLines(r);

  it("each word of the API has its title, and a count is passed through", () => {
    expect(rows({ id: "imported", count: 60 })[0]).toEqual({ id: "imported", count: 60, title: "Posts imported", note: "From your plan files" });
    expect(rows({ id: "sent", count: 12 })[0]).toMatchObject({ title: "Sent to Design Team", note: "Sent for design review" });
    expect(rows({ id: "reviewed", count: 5 })[0]).toMatchObject({ title: "Designs approved", note: "Approved by you" });
    expect(rows({ id: "sentBack", count: 1 })[0]).toMatchObject({ title: "Sent back to Marketing" });
    expect(rows({ id: "templates", count: 2 })[0]).toMatchObject({ title: "Templates added" });
  });

  it("a row with nothing says that, instead of describing something that did not happen", () => {
    for (const id of ["imported", "sent", "approved", "scheduled", "published", "reviewed", "sentBack", "templates"] as const) {
      expect(rows({ id, count: 0 })[0].note, id).toMatch(/^(No|Nothing)/);
    }
  });

  it("Published names the channels: one, two, or how many", () => {
    expect(rows({ id: "published", count: 1, channels: ["instagram"] })[0].note).toBe("Live on Instagram");
    expect(rows({ id: "published", count: 3, channels: ["instagram", "linkedin"] })[0].note).toBe("Live on Instagram and LinkedIn");
    expect(rows({ id: "published", count: 9, channels: ["instagram", "linkedin", "threads"] })[0].note).toBe("Live on 3 channels");
    expect(rows({ id: "published", count: 2, channels: [] })[0].note).toBe("Live this quarter");
    expect(rows({ id: "published", count: 2 })[0].note).toBe("Live this quarter");
  });

  it("a channel the page has no name for is shown as it is, and a word of the object prototype is not a name", () => {
    expect(rows({ id: "published", count: 1, channels: ["newplatform"] })[0].note).toBe("Live on newplatform");
    expect(rows({ id: "published", count: 1, channels: ["toString"] })[0].note).toBe("Live on toString");
  });

  it("keeps the order the API sent", () => {
    expect(rows({ id: "scheduled", count: 1 }, { id: "imported", count: 2 }).map((l) => l.id)).toEqual(["scheduled", "imported"]);
  });
});
