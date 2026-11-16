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
  lastSignIn: "Last sign-in today, 08:12 WIB · Chrome on macOS",
  passwordChanged: "Last changed 2 months ago",
  linkExpires: "Link expires after 30 minutes · request a new one anytime",
  twoStep: { on: true, detail: "Authenticator app · added 13 Nov 2026" },
};

export interface Device {
  id: string;
  /** The short label in the square tile: "Mac", "iOS", "Win". */
  tile: string;
  name: string;
  place: string;
  seen: string;
  current: boolean;
}

export const DEVICES: Device[] = [
  { id: "macbook", tile: "Mac", name: "MacBook Pro · Chrome on macOS", place: "Bandung, Indonesia", seen: "active now", current: true },
  { id: "iphone", tile: "iOS", name: "iPhone 15 · Postly app", place: "Bandung, Indonesia", seen: "last active 2 hours ago", current: false },
  { id: "windows", tile: "Win", name: "Windows PC · Edge", place: "Jakarta, Indonesia", seen: "last active 3 days ago", current: false },
];

export interface SignInRecord {
  id: string;
  when: string;
  device: string;
  place: string;
  /** null = it worked; otherwise why it did not. */
  failure: string | null;
}

export const SIGN_INS_RANGE = "Last 30 days";
export const SIGN_INS: SignInRecord[] = [
  { id: "1", when: "Today, 08:12 WIB", device: "Chrome · macOS", place: "Bandung, ID", failure: null },
  { id: "2", when: "Yesterday, 19:40 WIB", device: "Postly app · iOS", place: "Bandung, ID", failure: null },
  { id: "3", when: "10 Nov 2026, 22:05 WIB", device: "Firefox · Linux", place: "Surabaya, ID", failure: "Wrong password" },
  { id: "4", when: "9 Nov 2026, 09:01 WIB", device: "Edge · Windows", place: "Jakarta, ID", failure: null },
  { id: "5", when: "7 Nov 2026, 08:55 WIB", device: "Chrome · macOS", place: "Bandung, ID", failure: null },
];

export interface ActivityCount {
  id: string;
  count: number;
  title: string;
  note: string;
}

export const ACTIVITY: ActivityCount[] = [
  { id: "imported", count: 60, title: "Posts imported", note: "From your Q4 plan file" },
  { id: "design", count: 12, title: "Sent to Design Team", note: "Waiting for design review" },
  { id: "approved", count: 8, title: "Designs approved", note: "Ready for your final check" },
  { id: "scheduled", count: 2, title: "Scheduled", note: "Going live this week" },
  { id: "published", count: 1, title: "Published", note: "Live on Instagram" },
];
