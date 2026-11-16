import type { AppRole } from "./permissions";

/**
 * What a role is, in words, for the My Profile page: the name, the one-line duty in the green badge,
 * who the person works with, and what they can and cannot do. The page reads this and nothing else
 * about a role, so another role is a change of data here, not of markup. The rules themselves live
 * in permissions.ts; keep the sentences here in line with them.
 */
export interface RoleProfile {
  /** "Marketing": the role field, the "Role: Marketing" pill and the pill in the profile card. */
  label: string;
  /** The green badge: "Approves & publishes". */
  duty: string;
  /** The team this role works with day to day: "Design Team". */
  worksWith: string;
  can: string;
  cannot: string;
}

export const ROLE_PROFILE: Record<AppRole, RoleProfile> = {
  member: {
    label: "Marketing",
    duty: "Approves & publishes",
    worksWith: "Design Team",
    can: "Import plans, create posts, approve, schedule and publish",
    cannot: "Create, edit or publish templates",
  },
  designer: {
    label: "Design team",
    duty: "Reviews designs",
    worksWith: "Marketing Team",
    can: "Review and approve post designs, create and edit templates",
    cannot: "Create, import or publish posts",
  },
  admin: {
    label: "Admin",
    duty: "Manages the workspace",
    worksWith: "Marketing and Design teams",
    can: "Manage the team, accounts and settings, import plans, create posts, review, schedule and publish",
    cannot: "Create, edit or publish templates, or change roles and the plan",
  },
  owner: {
    label: "Owner",
    duty: "Manages the workspace",
    worksWith: "Marketing and Design teams",
    can: "Everything an admin can do, plus change roles and the plan or delete the workspace",
    cannot: "Create, edit or publish templates",
  },
};

/** The profile of a role. A missing or unknown role gets the narrowest one (the designer's), like permissions.ts. */
export function roleProfileOf(role: string | null | undefined): RoleProfile {
  return role !== null && role !== undefined && Object.hasOwn(ROLE_PROFILE, role) ? ROLE_PROFILE[role as AppRole] : ROLE_PROFILE.designer;
}
