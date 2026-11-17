import { describe, expect, it } from "vitest";
import { canAccessPage } from "@/lib/permissions";
import { ADD_ACCOUNT, DESIGN_GROUPS, FOOTER_ITEMS, MANAGE_GROUP, NAV_GROUPS, PROFILE_HREF, footerItemsFor, isActiveHref, manageGroupFor, navGroupsFor } from "./nav-config";

const ROLES = ["owner", "admin", "designer", "member"] as const;

const itemsOf = (role: string) => [...navGroupsFor(role).flatMap((g) => g.items), ...(manageGroupFor(role)?.items ?? []), ...footerItemsFor(role)];
const hrefsOf = (role: string) => itemsOf(role).map((i) => i.href).filter((h): h is string => h !== null);
const labelsOf = (role: string) => itemsOf(role).map((i) => i.label);
const ALL = [...NAV_GROUPS.flatMap((g) => g.items), ...MANAGE_GROUP.items, ...FOOTER_ITEMS];

describe("nav config", () => {
  it("has the groups and rows of the design, in order", () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(["Overview", "Content workspace", "Assets", "Channel"]);
    expect(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.label))).toEqual([
      "Dashboard", "Import quarter plan", "Content list", "My task", "Analytics", "Templates", "Media library", "Library", "Platform", "Groups",
    ]);
  });

  it("every row has a label and an icon, and no two rows share a label", () => {
    for (const i of ALL) {
      expect(i.label.length).toBeGreaterThan(0);
      expect(i.icon).toBeDefined();
    }
    expect(new Set(ALL.map((i) => i.label)).size).toBe(ALL.length);
  });

  it("the pages that do not exist yet are rows without a link", () => {
    const soon = ALL.filter((i) => i.href === null).map((i) => i.label);
    expect(soon).toEqual(["My task", "Media library", "Help & support"]);
  });

  it("the footer holds only help and settings, so the links above stay on a laptop screen", () => {
    expect(FOOTER_ITEMS.map((i) => i.label)).toEqual(["Help & support", "Setting & integration"]);
  });

  it("team and billing are their own group", () => {
    expect(MANAGE_GROUP.label).toBe("Workspace");
    expect(MANAGE_GROUP.items.map((i) => i.label)).toEqual(["Team", "Billing"]);
  });
});

describe("Setting & integration", () => {
  const setting = (role: string) => footerItemsFor(role).find((i) => i.label === "Setting & integration");

  it("opens /settings for an owner and an admin", () => {
    for (const r of ["owner", "admin"]) expect(setting(r)!.href).toBe("/settings");
  });

  it("opens My profile for the roles that may not open /settings, so the row is still there", () => {
    for (const r of ["member", "designer", "nobody"]) expect(setting(r)!.href, r).toBe(PROFILE_HREF);
    expect(PROFILE_HREF).toBe("/profile");
  });

  it("/profile is open to every role, so the row never bounces anyone", () => {
    for (const r of ROLES) expect(canAccessPage(PROFILE_HREF, r), r).toBe(true);
  });

  it("the row lights up on /profile", () => {
    expect(isActiveHref("/profile", PROFILE_HREF)).toBe(true);
    expect(isActiveHref("/settings", PROFILE_HREF)).toBe(false);
  });

  it("the footer keeps its two rows for every role", () => {
    for (const r of ROLES) expect(footerItemsFor(r).map((i) => i.label), r).toEqual(["Help & support", "Setting & integration"]);
  });
});

describe("navGroupsFor / footerItemsFor", () => {
  it("owner and admin see every page", () => {
    for (const r of ["owner", "admin"]) {
      expect(hrefsOf(r)).toEqual(expect.arrayContaining(["/dashboard", "/jobs", "/jobs/import", "/analytics", "/templates", "/library", "/integrations", "/groups", "/settings", "/team", "/billing"]));
      expect(labelsOf(r)).toHaveLength(ALL.length);
    }
  });

  it("a link is never shown to a role the page guard would bounce", () => {
    for (const r of ROLES) for (const href of hrefsOf(r)) expect(canAccessPage(href, r), `${r} ${href}`).toBe(true);
  });

  it("a designer has the design team's sidebar: Dashboard, then Master Template and My task, then help and settings", () => {
    expect(navGroupsFor("designer").map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([
      ["Overview", ["Dashboard"]],
      ["Design workspace", ["Master Template", "My task"]],
    ]);
    expect(hrefsOf("designer")).toEqual(["/dashboard", "/templates", "/profile"]);
    expect(labelsOf("designer")).toEqual(["Dashboard", "Master Template", "My task", "Help & support", "Setting & integration"]);
  });

  it("a designer's sidebar leaves out the Content list and the Media library, which the design does not have", () => {
    expect(labelsOf("designer")).not.toContain("Content list");
    expect(labelsOf("designer")).not.toContain("Media library");
    expect(hrefsOf("designer")).not.toContain("/jobs");
  });

  it("My task waits for the 'assign to designer' step of add/edit content: a dimmed row, not a link", () => {
    const row = DESIGN_GROUPS.flatMap((g) => g.items).find((i) => i.label === "My task");
    expect(row?.href).toBeNull();
  });

  it("only a designer, and an unknown role, gets the design team's groups; the others keep theirs", () => {
    for (const r of ["owner", "admin", "member"]) expect(navGroupsFor(r).map((g) => g.label), r).not.toContain("Design workspace");
    expect(navGroupsFor("designer")).toEqual(DESIGN_GROUPS);
  });

  it("a member also gets import and analytics, but none of the manage pages", () => {
    expect(hrefsOf("member")).toEqual(["/dashboard", "/jobs/import", "/jobs", "/analytics", "/templates", "/profile"]);
    for (const p of ["/library", "/integrations", "/groups", "/settings", "/team", "/billing"]) expect(hrefsOf("member"), p).not.toContain(p);
  });

  it("a group with nothing left is dropped", () => {
    for (const r of ROLES) for (const g of navGroupsFor(r)) expect(g.items.length).toBeGreaterThan(0);
    expect(navGroupsFor("designer").map((g) => g.label)).not.toContain("Channel");
    expect(navGroupsFor("designer").map((g) => g.label)).not.toContain("Assets");
    expect(manageGroupFor("designer")).toBeNull();
    expect(manageGroupFor("member")).toBeNull();
    expect(manageGroupFor("owner")!.items.map((i) => i.label)).toEqual(["Team", "Billing"]);
  });

  it("an unknown role gets the narrowest view and cannot reach the owner pages", () => {
    for (const odd of [undefined, null, "superuser"]) {
      expect(hrefsOf(odd as string)).toEqual(["/dashboard", "/templates", "/profile"]);
    }
  });

  it("Add account points at a page with its own guard", () => {
    expect(ADD_ACCOUNT.href).toBe("/accounts");
    expect(canAccessPage(ADD_ACCOUNT.href, "member")).toBe(false);
    expect(canAccessPage(ADD_ACCOUNT.href, "admin")).toBe(true);
  });
});

describe("isActiveHref", () => {
  it("an exact match is active", () => {
    expect(isActiveHref("/dashboard", "/dashboard")).toBe(true);
    expect(isActiveHref("/jobs", "/jobs")).toBe(true);
  });

  it("a sub-page lights up its parent", () => {
    expect(isActiveHref("/jobs/123", "/jobs")).toBe(true);
    expect(isActiveHref("/team/invite", "/team")).toBe(true);
  });

  it("/jobs/import lights up import, NOT content list as well", () => {
    expect(isActiveHref("/jobs/import", "/jobs/import")).toBe(true);
    expect(isActiveHref("/jobs/import", "/jobs")).toBe(false);
  });

  it("a path that only starts with the same letters is not that page", () => {
    expect(isActiveHref("/jobsearch", "/jobs")).toBe(false);
    expect(isActiveHref("/accounts-old", "/accounts")).toBe(false);
  });

  it("a row without a link is never active", () => {
    expect(isActiveHref("/dashboard", null)).toBe(false);
  });

  it("exactly one row is active on every page the sidebar links to", () => {
    const rows = ALL.filter((i) => i.href !== null);
    for (const probe of rows) {
      const active = rows.filter((r) => isActiveHref(probe.href as string, r.href));
      expect(active.map((r) => r.label), probe.href as string).toEqual([probe.label]);
    }
  });
});
