import { PILLARS } from "./contentTypes";
import { formatTime, wibDateKey, APP_TIMEZONE } from "./datetime";
import { shortName } from "./dashboard-format";
import { shortDayLabel } from "./content-list";

// The words of the designer's dashboard. GET /dashboard/design sends data (who, when, how many); the sentences are
// written here, so a reader of the page finds its wording in one place.

export interface PostMedia {
  images: number;
  video: boolean;
  mediaType: "reel" | "story" | null;
  youtubeType: "short" | "video" | null;
}

export interface ApiQueuePost {
  id: string;
  status: string;
  approvalStatus: string | null;
  title: string;
  thumbnail: string | null;
  pillar: string | null;
  media: PostMedia;
  submitCount: number;
  submittedAt: string | null;
  submittedBy: string | null;
  scheduledFor: string | null;
}

export interface ApiDesignActivity {
  kind: "submitted" | "approved" | "revision" | "template";
  at: string;
  by: string | null;
  mine: boolean;
  title: string;
  pillar: string | null;
}

export interface ApiDesignDashboard {
  pending: number;
  approved: number;
  revision: number;
  queue: ApiQueuePost[];
  activities: ApiDesignActivity[];
  templates: { pillar: string | null; published: boolean }[];
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A design that has waited this long is shown in red. */
const LATE_AFTER_DAYS = 2;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ── The review queue ────────────────────────────────────────────────────────

/** What the design is: "Carousel · 5 slides", "Single image", "Reel", "Video", or "No media yet". */
export function formatLabel(media: PostMedia): string {
  if (media.mediaType === "reel") return "Reel";
  if (media.mediaType === "story") return "Story";
  if (media.youtubeType === "short") return "YouTube Short";
  if (media.youtubeType === "video") return "YouTube video";
  if (media.video) return "Video";
  if (media.images > 1) return `Carousel · ${media.images} slides`;
  if (media.images === 1) return "Single image";
  return "No media yet";
}

/** The line under a title: "v1 · first submission", then "v2 · revision round 2" once it has been sent again. */
export function versionLabel(submitCount: number): string {
  return submitCount <= 1 ? "v1 · first submission" : `v${submitCount} · revision round ${submitCount}`;
}

/** How long a design has waited: "< 1 h", "5 h", "3 d". `late` once it is two days or more. Nothing recorded: a dash. */
export function waitingLabel(submittedAt: string | null, now: Date): { text: string; late: boolean } {
  const since = submittedAt ? new Date(submittedAt).getTime() : NaN;
  if (Number.isNaN(since)) return { text: "—", late: false };
  const ms = Math.max(0, now.getTime() - since);
  if (ms < HOUR) return { text: "< 1 h", late: false };
  if (ms < DAY) return { text: `${Math.floor(ms / HOUR)} h`, late: false };
  const days = Math.floor(ms / DAY);
  return { text: `${days} d`, late: days >= LATE_AFTER_DAYS };
}

/** The whole days from `from` to `to`, counted on the WIB calendar (a post at 00:30 is "tomorrow" for someone at 23:00). */
function daysBetween(from: Date, to: Date): number {
  const a = Date.parse(`${wibDateKey(from)}T00:00:00Z`);
  const b = Date.parse(`${wibDateKey(to)}T00:00:00Z`);
  return Math.round((b - a) / DAY);
}

/**
 * The publish date in two lines: "Mon 17 Nov" over "09:00 · in 4 days". `urgent` when it is today, tomorrow or past:
 * the second line is red then. A post with no date has none.
 */
export function publishLines(scheduledFor: string | null, now: Date): { day: string; time: string; urgent: boolean } | null {
  const at = scheduledFor ? new Date(scheduledFor) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const days = daysBetween(now, at);
  const when = days < 0 ? "overdue" : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return { day: shortDayLabel(wibDateKey(at)), time: `${formatTime(at)} · ${when}`, urgent: days <= 1 };
}

/** "Showing 5 of 9 designs waiting · 3 sent back for revision · 46 approved this quarter" */
export function queueFooter(shown: number, pending: number, revision: number, approved: number): string {
  const waiting = `Showing ${shown} of ${plural(Math.max(pending, shown), "design", "designs")} waiting`;
  return `${waiting} · ${revision} sent back for revision · ${approved} approved this quarter`;
}

// ── Recent activities ───────────────────────────────────────────────────────

const dayAndMonth = (d: Date): string => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: APP_TIMEZONE, day: "numeric", month: "short" }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${get("month")}`;
};

/** "09:12" today, "yesterday 16:40", else "11 Nov 14:22", all in WIB. */
export function activityTime(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = formatTime(at);
  const days = daysBetween(at, now);
  if (days <= 0) return time;
  if (days === 1) return `yesterday ${time}`;
  return `${dayAndMonth(at)} ${time}`;
}

/** The two lines of an event: a title and what happened. */
export function activityLines(a: ApiDesignActivity, now: Date): { title: string; detail: string } {
  const time = activityTime(a.at, now);
  const who = a.mine ? "You" : shortName(a.by) || "Someone";
  const quoted = `“${a.title}”`;
  switch (a.kind) {
    case "submitted":
      return { title: "New design submitted by Marketing", detail: `${who} submitted ${quoted} · ${time}` };
    case "approved":
      return { title: "Design approved", detail: `${who} approved ${quoted} · ${time}` };
    case "revision":
      return { title: "Revision requested", detail: `${who} asked for changes on ${quoted} · ${time}` };
    case "template":
      return { title: "New template uploaded", detail: `${quoted} added to ${a.pillar ?? "No pillar"} · ${time}` };
  }
}

// ── Templates ───────────────────────────────────────────────────────────────

type Template = ApiDesignDashboard["templates"][number];

/** A published template is seen by Marketing; a draft is the design team's alone (the Template Library page). */
export function templateTotals(list: readonly Template[]): { total: number; published: number; draft: number } {
  const published = list.filter((t) => t.published).length;
  return { total: list.length, published, draft: list.length - published };
}

export interface PillarRow {
  pillar: string;
  total: number;
  published: number;
}

/** One row per pillar, in the order of the content types; "No pillar" only when a template is there. */
export function templatePillars(list: readonly Template[]): PillarRow[] {
  const row = (pillar: string, items: readonly Template[]): PillarRow => ({ pillar, total: items.length, published: items.filter((t) => t.published).length });
  const rows = PILLARS.map((p) => row(p, list.filter((t) => t.pillar === p)));
  const rest = list.filter((t) => !t.pillar || !(PILLARS as readonly string[]).includes(t.pillar));
  return rest.length > 0 ? [...rows, row("No pillar", rest)] : rows;
}

/** "6 templates · 5 published" */
export function templatesLine(r: PillarRow): string {
  return r.total === 0 ? "No templates yet" : `${plural(r.total, "template", "templates")} · ${r.published} published`;
}

/** The sentence under the greeting. */
export function designSubtitle(pending: number, drafts: number): string {
  const waiting =
    pending === 0
      ? "No designs from the Marketing Team are waiting for your review"
      : `${plural(pending, "design", "designs")} from the Marketing Team ${pending === 1 ? "is" : "are"} waiting for your review`;
  const templates = drafts === 0 ? "" : ` · ${plural(drafts, "template", "templates")} still in Draft`;
  return `${waiting}${templates}.`;
}
