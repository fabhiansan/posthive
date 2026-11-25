// Approving a post is the owner's and the admin's. The design team makes designs (routes/designTasks.ts) and manages
// templates; it does not approve content, over the web, the public REST API or MCP (every one of them asks isManageRole).
import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma.js", () => ({ prisma: {} }));

import { MANAGE_ROLES, isManageRole } from "./withAuth.js";

describe("isManageRole", () => {
  it.each(["owner", "admin"])("%s approves", (role) => {
    expect(isManageRole(role)).toBe(true);
  });

  it.each(["designer", "member", "", "Owner", null, undefined])("%s does not", (role) => {
    expect(isManageRole(role as string | null | undefined)).toBe(false);
  });

  it("the list has no designer in it", () => {
    expect([...MANAGE_ROLES]).toEqual(["owner", "admin"]);
  });
});
