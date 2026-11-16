import { describe, expect, it } from "vitest";
import { memberSince, planLine, quarterOf } from "./profile";

describe("planLine", () => {
  it("names a paid plan with its interval", () => {
    expect(planLine("pro", "annual")).toBe("Pro plan · annual");
    expect(planLine("creator", "annual")).toBe("Creator plan · annual");
    expect(planLine("team", "monthly")).toBe("Team plan · monthly");
  });

  it("a plan whose interval is not known is named without one", () => {
    expect(planLine("pro")).toBe("Pro plan");
    expect(planLine("team", undefined)).toBe("Team plan");
    expect(planLine("pro", "")).toBe("Pro plan");
  });

  it("a trial and a cancelled plan have no interval", () => {
    expect(planLine("trialing", "annual")).toBe("Free trial");
    expect(planLine("cancelled", "annual")).toBe("Plan cancelled");
  });

  it("a missing or unknown plan says so and does not break", () => {
    for (const odd of [undefined, null, "", "enterprise", "toString"]) expect(planLine(odd, "annual")).toBe("No plan");
  });
});

describe("quarterOf", () => {
  const at = (iso: string) => quarterOf(new Date(iso));

  it("names each quarter and the day its counts start over", () => {
    expect(at("2026-11-16T03:00:00Z")).toEqual({ label: "Q4 2026", resets: "1 January" });
    expect(at("2026-02-10T03:00:00Z")).toEqual({ label: "Q1 2026", resets: "1 April" });
    expect(at("2026-05-10T03:00:00Z")).toEqual({ label: "Q2 2026", resets: "1 July" });
    expect(at("2026-08-10T03:00:00Z")).toEqual({ label: "Q3 2026", resets: "1 October" });
  });

  it("the edges of a quarter belong to the right one", () => {
    expect(at("2026-10-01T03:00:00Z").label).toBe("Q4 2026");
    expect(at("2026-09-30T03:00:00Z").label).toBe("Q3 2026");
    expect(at("2026-12-31T03:00:00Z").label).toBe("Q4 2026");
  });

  it("counts the day in WIB: 18:00 UTC on 31 Dec is already January in Jakarta", () => {
    expect(at("2026-12-31T18:00:00Z")).toEqual({ label: "Q1 2027", resets: "1 April" });
    expect(at("2026-09-30T18:00:00Z")).toEqual({ label: "Q4 2026", resets: "1 January" });
  });
});

describe("memberSince", () => {
  it("writes the day the person joined", () => {
    expect(memberSince("2026-11-13T03:00:00.000Z")).toBe("13 Nov 2026");
  });

  it("uses the day in WIB", () => {
    expect(memberSince("2026-11-12T20:00:00.000Z")).toBe("13 Nov 2026");
  });

  it("is empty when there is no date or it is not one", () => {
    for (const odd of [undefined, null, "", "not a date"]) expect(memberSince(odd)).toBe("");
  });
});
