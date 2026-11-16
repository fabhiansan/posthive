import { describe, expect, it } from "vitest";
import { canEditContent, canManageTemplates, canReview, type AppRole } from "./permissions";
import { ABOUT_MAX, ROLE_SAMPLE, sampleOf } from "./profile-mock";
import { ROLE_PROFILE, roleProfileOf } from "./role-profile";

const ROLES: AppRole[] = ["owner", "admin", "designer", "member"];

describe("role profile", () => {
  it("every role has all five parts filled in", () => {
    for (const r of ROLES) {
      const p = ROLE_PROFILE[r];
      for (const part of [p.label, p.duty, p.worksWith, p.can, p.cannot]) expect(part.trim().length, r).toBeGreaterThan(0);
    }
  });

  it("the Marketing role says what the design says", () => {
    expect(ROLE_PROFILE.member).toEqual({
      label: "Marketing",
      duty: "Approves & publishes",
      worksWith: "Design Team",
      can: "Import plans, create posts, approve, schedule and publish",
      cannot: "Create, edit or publish templates",
    });
  });

  it("no two roles share a name", () => {
    expect(new Set(ROLES.map((r) => ROLE_PROFILE[r].label)).size).toBe(ROLES.length);
  });

  // The sentences are written by hand: this keeps them from saying the opposite of the rules
  it("what it says a role cannot do is not something the rules let it do", () => {
    expect(canManageTemplates("member")).toBe(false);
    expect(ROLE_PROFILE.member.cannot).toMatch(/templates/);
    expect(canManageTemplates("designer")).toBe(true);
    expect(ROLE_PROFILE.designer.can).toMatch(/templates/);
    expect(canEditContent("designer")).toBe(false);
    expect(ROLE_PROFILE.designer.cannot).toMatch(/posts/);
    expect(canReview("member")).toBe(false);
  });

  it("an unknown or missing role gets the designer's profile, the narrowest", () => {
    for (const odd of [undefined, null, "", "superuser", "toString", "constructor"]) {
      expect(roleProfileOf(odd)).toBe(ROLE_PROFILE.designer);
    }
  });

  it("a known role gets its own", () => {
    for (const r of ROLES) expect(roleProfileOf(r)).toBe(ROLE_PROFILE[r]);
  });
});

describe("the sample of a role", () => {
  it("every role has a job title and at least one team", () => {
    for (const r of ROLES) {
      expect(ROLE_SAMPLE[r].jobTitle.trim().length, r).toBeGreaterThan(0);
      expect(ROLE_SAMPLE[r].teams.length, r).toBeGreaterThan(0);
    }
  });

  it("the Marketing words belong to Marketing alone", () => {
    expect(ROLE_SAMPLE.member.jobTitle).toBe("Marketing Lead");
    expect(ROLE_SAMPLE.member.about.length).toBeGreaterThan(0);
    for (const r of ["designer", "admin", "owner"] as const) {
      expect(ROLE_SAMPLE[r].about, r).toBe("");
      expect(ROLE_SAMPLE[r].jobTitle, r).not.toMatch(/Marketing/);
      for (const t of ROLE_SAMPLE[r].teams) expect(t.team, r).not.toBe("Marketing");
    }
  });

  it("the sample text fits the limit of the About field", () => {
    for (const r of ROLES) expect(ROLE_SAMPLE[r].about.length, r).toBeLessThanOrEqual(ABOUT_MAX);
  });

  it("an unknown or missing role gets the designer's sample, never an object's own method", () => {
    for (const odd of [undefined, null, "", "superuser", "toString", "constructor"]) expect(sampleOf(odd)).toBe(ROLE_SAMPLE.designer);
    for (const r of ROLES) expect(sampleOf(r)).toBe(ROLE_SAMPLE[r]);
  });
});
