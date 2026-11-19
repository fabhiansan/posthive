import type { AppRole } from "./permissions";

/**
 * Everything on My Profile that no API gives us yet, in one place so that each part can be swapped
 * for a request without touching the page: the person's own words and job, the team and language
 * lists, notification choices, the sign-in security facts, devices, recent sign-ins and the counts of
 * the quarter. The page shows these as they are; only the full name is saved for real.
 */

/**
 * This file stands in for what no API gives yet. Shown while building and testing; in production it
 * would pass for facts about the real person (a second login step they never set up, devices they
 * never used), so the page leaves those parts out there.
 */
export function sampleOn(): boolean {
  return process.env.NODE_ENV !== "production";
}

export interface Choice {
  value: string;
  label: string;
}

export interface TeamChoice extends Choice {
  /** The team on its own, for "Marketing · Braga Tech" in Role & permissions. */
  team: string;
}

export const ABOUT_MAX = 300;
export const NAME_MAX = 100;

/** What the person says about themselves and which team they pick from, for one role. */
export interface RoleSample {
  jobTitle: string;
  about: string;
  teams: TeamChoice[];
}

const MANAGEMENT: TeamChoice[] = [{ value: "management", label: "Management", team: "Management" }];

export const ROLE_SAMPLE: Record<AppRole, RoleSample> = {
  member: {
    jobTitle: "Marketing Lead",
    about: "Marketing lead for Braga Geo. I plan the quarterly content calendar and approve posts before they go live on Instagram and LinkedIn.",
    teams: [
      { value: "marketing-content", label: "Marketing · Content", team: "Marketing" },
      { value: "marketing-social", label: "Marketing · Social", team: "Marketing" },
      { value: "marketing-brand", label: "Marketing · Brand", team: "Marketing" },
    ],
  },
  designer: { jobTitle: "Designer", about: "", teams: [{ value: "design", label: "Design Team", team: "Design" }] },
  admin: { jobTitle: "Admin", about: "", teams: MANAGEMENT },
  owner: { jobTitle: "Owner", about: "", teams: MANAGEMENT },
};

/** The sample of a role; a missing or unknown role gets the designer's, like roleProfileOf. */
export function sampleOf(role: string | null | undefined): RoleSample {
  return role !== null && role !== undefined && Object.hasOwn(ROLE_SAMPLE, role) ? ROLE_SAMPLE[role as AppRole] : ROLE_SAMPLE.designer;
}

export const LANGUAGES: Choice[] = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "id-ID", label: "Bahasa Indonesia" },
];
export const LANGUAGE = "en-US";

/** The person at the other end of "Works with", by role. */
export const WORKS_WITH_CONTACT: Partial<Record<AppRole, string>> = { member: "Dewi W." };

export const PLAN_INTERVAL = "annual";

export interface NotificationChoice {
  id: string;
  title: string;
  note: string;
  on: boolean;
}

export const NOTIFICATIONS_SCOPE = "Email and in-app";
export const NOTIFICATIONS: NotificationChoice[] = [
  { id: "design-ready", title: "Design ready", note: "When the Design Team approves a post design for you", on: true },
  { id: "revision-requests", title: "Revision requests", note: "When a designer sends a design back with notes", on: true },
  { id: "publishing-results", title: "Publishing results", note: "When a scheduled post goes live or fails to publish", on: true },
  { id: "plan-deadlines", title: "Plan deadlines", note: "Morning digest at 08:00 WIB of posts due this week", on: true },
  { id: "weekly-report", title: "Weekly report", note: "Monday summary of posts published and engagement", on: false },
];

export const SIGN_IN = {
  passwordChanged: "Last changed 2 months ago",
  linkExpires: "Link expires after 30 minutes · request a new one anytime",
};
