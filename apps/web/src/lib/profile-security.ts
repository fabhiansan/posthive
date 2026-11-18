import { formatTime, wibDateKey, APP_TZ_LABEL, APP_TIMEZONE } from "./datetime";

// The words of "Devices & login history" and "Your activity". GET /user/devices and /user/activity send data;
// the sentences are written here, so a reader of the page finds its wording in one place.

export interface ApiDevice {
  id: string;
  /** The short word in the square tile: "Mac", "Win", "iOS". */
  tile: string;
  /** "Chrome on macOS" */
  name: string;
  startedAt: string;
  lastActiveAt: string;
  current: boolean;
}

export interface ApiSignIn {
  id: string;
  at: string;
  device: string;
  /** null = it worked; otherwise why it did not. */
  failure: string | null;
}

export interface ApiDevices {
  devices: ApiDevice[];
  /** How many days back the sign-in history goes (the API keeps it that long). */
  days: number;
  signIns: ApiSignIn[];
}

export interface ApiActivityRow {
  id: "imported" | "sent" | "approved" | "scheduled" | "published" | "reviewed" | "sentBack" | "templates";
  count: number;
  channels?: string[];
}

export interface ApiActivity {
  quarter: string;
  kind: "maker" | "reviewer";
  rows: ApiActivityRow[];
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The WIB calendar days from `from` to `to`. */
function daysBetween(from: Date, to: Date): number {
  return Math.round((Date.parse(`${wibDateKey(to)}T00:00:00Z`) - Date.parse(`${wibDateKey(from)}T00:00:00Z`)) / DAY);
}

const dayAndMonth = (d: Date, withYear: boolean): string => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: APP_TIMEZONE, day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${get("month")}${withYear ? ` ${get("year")}` : ""}`;
};

/** "active now" while it is moving, then "last active 2 hours ago", "last active 3 days ago". */
export function lastSeenLabel(iso: string, current: boolean, now: Date): string {
  if (current) return "active now";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const ms = Math.max(0, now.getTime() - at);
  if (ms < 5 * MIN) return "active now";
  if (ms < HOUR) return `last active ${plural(Math.floor(ms / MIN), "minute", "minutes")} ago`;
  if (ms < DAY) return `last active ${plural(Math.floor(ms / HOUR), "hour", "hours")} ago`;
  return `last active ${plural(Math.floor(ms / DAY), "day", "days")} ago`;
}

/** "Today, 08:12 WIB", "Yesterday, 19:40 WIB", "10 Nov 2026, 22:05 WIB". */
export function signInTime(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = `${formatTime(at)} ${APP_TZ_LABEL}`;
  const days = daysBetween(at, now);
  if (days <= 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return `${dayAndMonth(at, true)}, ${time}`;
}

/** The corner note of Password & sign-in: "Last sign-in today, 08:12 WIB · Chrome on macOS". Only a sign-in that worked. */
export function lastSignInLine(signIns: readonly ApiSignIn[], now: Date): string | undefined {
  const last = signIns.find((s) => s.failure === null);
  if (!last) return undefined;
  const time = signInTime(last.at, now);
  return `Last sign-in ${time.charAt(0).toLowerCase()}${time.slice(1)} · ${last.device}`;
}

// ── Your activity ───────────────────────────────────────────────────────────

export interface ActivityLine {
  id: ApiActivityRow["id"];
  count: number;
  title: string;
  note: string;
}

const CHANNEL_NAMES: Record<string, string> = { instagram: "Instagram", linkedin: "LinkedIn", facebook: "Facebook", threads: "Threads", youtube: "YouTube", pinterest: "Pinterest", bluesky: "Bluesky", mastodon: "Mastodon", telegram: "Telegram", twitter: "X", discord: "Discord", tumblr: "Tumblr", lemmy: "Lemmy", nostr: "Nostr" };

/** "Live on Instagram", "Live on Instagram and LinkedIn", "Live on 3 channels"; "Nothing live yet" with none. */
function liveNote(count: number, channels: readonly string[] | undefined): string {
  if (count === 0) return "Nothing live yet";
  const names = (channels ?? []).map((c) => (Object.hasOwn(CHANNEL_NAMES, c) ? CHANNEL_NAMES[c] : c));
  if (names.length === 0) return "Live this quarter";
  if (names.length === 1) return `Live on ${names[0]}`;
  if (names.length === 2) return `Live on ${names[0]} and ${names[1]}`;
  return `Live on ${names.length} channels`;
}

/** What each row of the card says, by the word the API keys it on. */
const WORDS: Record<ApiActivityRow["id"], (row: ApiActivityRow) => { title: string; note: string }> = {
  imported: (r) => ({ title: "Posts imported", note: r.count === 0 ? "No plan file imported yet" : "From your plan files" }),
  sent: (r) => ({ title: "Sent to Design Team", note: r.count === 0 ? "Nothing sent for review yet" : "Sent for design review" }),
  approved: (r) => ({ title: "Designs approved", note: r.count === 0 ? "No design approved yet" : "Approved by the design team" }),
  scheduled: (r) => ({ title: "Scheduled", note: r.count === 0 ? "Nothing waiting to go live" : "Waiting for their time" }),
  published: (r) => ({ title: "Published", note: liveNote(r.count, r.channels) }),
  reviewed: (r) => ({ title: "Designs approved", note: r.count === 0 ? "No design approved yet" : "Approved by you" }),
  sentBack: (r) => ({ title: "Sent back to Marketing", note: r.count === 0 ? "Nothing sent back" : "Asked for changes" }),
  templates: (r) => ({ title: "Templates added", note: r.count === 0 ? "No template added yet" : "Added to the library" }),
};

export function activityLines(rows: readonly ApiActivityRow[]): ActivityLine[] {
  return rows.map((r) => ({ id: r.id, count: r.count, ...WORDS[r.id](r) }));
}
