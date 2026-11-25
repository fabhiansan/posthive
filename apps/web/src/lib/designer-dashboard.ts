import { PILLARS } from "./contentTypes";
import { formatTime, wibDateKey, APP_TIMEZONE } from "./datetime";
import { shortName } from "./dashboard-format";
import { shortDayLabel } from "./content-list";
import type { TaskCounts, TaskItem } from "./design-tasks";

// The words of the designer's dashboard (docs/design/designer/dashboard.png). GET /dashboard/design sends data (who, when,
// how many); the sentences are written here, so a reader of the page finds its wording in one place. The words of the
// tasks themselves (due, status, the subtitle) are in design-tasks.ts.

export interface ApiDesignActivity {
  kind: "assigned" | "sent" | "template";
  at: string;
  by: string | null;
  mine: boolean;
  title: string;
  pillar: string | null;
}

export interface ApiDesignDashboard {
  counts: TaskCounts;
  /** The open tasks, soonest deadline first. */
  tasks: TaskItem[];
  activities: ApiDesignActivity[];
  templates: { pillar: string | null; published: boolean }[];
}

const DAY = 24 * 60 * 60 * 1000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The whole days from `from` to `to`, counted on the WIB calendar (a post at 00:30 is "tomorrow" for someone at 23:00). */
function daysBetween(from: Date, to: Date): number {
  const a = Date.parse(`${wibDateKey(from)}T00:00:00Z`);
  const b = Date.parse(`${wibDateKey(to)}T00:00:00Z`);
  return Math.round((b - a) / DAY);
}

/**
 * The deadline in two lines: "Mon 17 Nov" over "09:00 · in 4 days". `urgent` when it is today, tomorrow or past: the
 * second line is red then. A task with no deadline has none.
 */
export function dueLines(deadline: string | null, now: Date): { day: string; time: string; urgent: boolean } | null {
  const at = deadline ? new Date(deadline) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const days = daysBetween(now, at);
  const when = days < 0 ? "overdue" : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return { day: shortDayLabel(wibDateKey(at)), time: `${formatTime(at)} · ${when}`, urgent: days <= 1 };
}

// ── Recent activity ─────────────────────────────────────────────────────────

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
  const quoted = `“${a.title}”`;
  switch (a.kind) {
    case "assigned":
      return { title: "New task assigned", detail: `${shortName(a.by) || "Marketing"} assigned ${quoted} to you · ${time}` };
    case "sent":
      return { title: "Design sent to Marketing", detail: `You sent the Figma link for ${quoted} · ${time}` };
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
