// The design team's side of a design request (My Task): the types of what the API sends, the calls, and the words of the
// pages. GET /design-tasks and /dashboard/design send data (who, when, how many); the sentences are written here.
import { apiFetch } from "./api";
import { dayLabel } from "./content-list";
import { formatTime, wibDateKey, APP_TZ_LABEL } from "./datetime";
import { shortName } from "./dashboard-format";
import { isFigmaDesignUrl } from "./figmaLink";

export type TaskStatus = "assigned" | "progress" | "done";
export type TaskTab = "all" | TaskStatus;

export const TASK_TABS: { id: TaskTab; label: string }[] = [
  { id: "all", label: "All tasks" },
  { id: "assigned", label: "Assigned" },
  { id: "progress", label: "In progress" },
  { id: "done", label: "Done" },
];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { assigned: "Assigned", progress: "In progress", done: "Done" };

export interface TaskCounts {
  assigned: number;
  progress: number;
  done: number;
  /** Done tasks whose post Marketing has not sent for review yet. */
  waiting: number;
}

export interface TaskItem {
  postId: string;
  title: string;
  thumbnail: string | null;
  pillar: string | null;
  format: "single" | "carousel" | null;
  status: TaskStatus;
  assignedBy: string | null;
  deadline: string | null;
  sentAt: string | null;
  doneAt: string | null;
  scheduledFor: string | null;
  channels: string[];
  brief: string;
}

export interface TaskList {
  counts: TaskCounts;
  tab: TaskTab;
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  items: TaskItem[];
}

export interface TaskLink {
  link: string | null;
  text: string;
}

export interface TaskDetail extends TaskItem {
  revisionNote?: string | null;
  caption: string;
  captionLength: number;
  category: string | null;
  briefFull: string;
  referenceUrl: string | null;
  postStatus: string;
  approvalStatus: string | null;
  accounts: { platform: string; displayName: string }[];
  copywriting: TaskLink;
  assets: TaskLink;
  figmaUrl: string | null;
  designerNote: string | null;
  history: { kind: "sent" | "draft" | "done"; at: string }[];
}

/** What Figma said about a link (POST /design-tasks/check-link). */
export type FigmaCheck =
  | { state: "valid"; title: string | null }
  | { state: "format" }
  | { state: "private" }
  | { state: "unreachable" };

export const fetchTasks = (tab: TaskTab, page: number) => apiFetch<TaskList>(`/design-tasks?tab=${tab}&page=${page}`);
export const fetchTask = (postId: string) => apiFetch<{ task: TaskDetail }>(`/design-tasks/${encodeURIComponent(postId)}`).then((r) => r.task);
export const checkFigma = (url: string) => apiFetch<FigmaCheck>("/design-tasks/check-link", { method: "POST", body: JSON.stringify({ url }) });
export const saveTaskDraft = (postId: string, body: { figmaUrl: string; note: string }) =>
  apiFetch<{ ok: true }>(`/design-tasks/${encodeURIComponent(postId)}/draft`, { method: "PUT", body: JSON.stringify(body) });
export const markTaskDone = (postId: string, body: { figmaUrl: string; note: string }) =>
  apiFetch<{ ok: true; title: string | null; checked: boolean }>(`/design-tasks/${encodeURIComponent(postId)}/done`, { method: "POST", body: JSON.stringify(body) });

// ── The link field ──────────────────────────────────────────────────────────

/** A pasted link, cleaned the way the API cleans it. */
export const cleanLink = (raw: string) => raw.trim();

/**
 * What the line under the Figma link field says, and whether Mark as done may be pressed. `checked` is the answer of
 * Figma for exactly this link, or null while it has not been asked (typing) or is being asked (`checking`).
 *  - empty: nothing to say, Mark as done off (the link is the point of the task).
 *  - a link that is not a Figma file: off, says what a Figma link looks like. Needs no request.
 *  - asking: off for the moment.
 *  - private: off, says how to share it.
 *  - unreachable: ON. Figma could not be asked, so the link is not proven wrong; the designer is warned and decides.
 */
export interface LinkState {
  tone: "idle" | "checking" | "valid" | "warn" | "error";
  message: string;
  canMarkDone: boolean;
}

export function linkState(raw: string, checking: boolean, checked: FigmaCheck | null): LinkState {
  const link = cleanLink(raw);
  if (!link) return { tone: "idle", message: "", canMarkDone: false };
  if (!isFigmaDesignUrl(link)) {
    return { tone: "error", message: "Use a Figma link, like https://www.figma.com/design/… (file, design, proto or board).", canMarkDone: false };
  }
  if (checking || !checked) return { tone: "checking", message: "Checking the link…", canMarkDone: false };
  switch (checked.state) {
    case "valid":
      return { tone: "valid", message: checked.title ? `Link valid · ${checked.title}` : "Link valid · Marketing can open it", canMarkDone: true };
    case "private":
      return { tone: "error", message: "Figma can't open this link. Set sharing to “Anyone with the link can view”, then check again.", canMarkDone: false };
    case "unreachable":
      return { tone: "warn", message: "Couldn't check the link right now. Make sure sharing is “Anyone with the link can view”.", canMarkDone: true };
    case "format":
      return { tone: "error", message: "Use a Figma link, like https://www.figma.com/design/… (file, design, proto or board).", canMarkDone: false };
  }
}

// ── Words ───────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Carousel", "Single image", or a dash while Marketing has not picked a format. */
export const formatOf = (t: Pick<TaskItem, "format">): string => (t.format === "carousel" ? "Carousel" : t.format === "single" ? "Single image" : "—");

/** The date of a task as two lines: "Mon 17 Nov, 09:00 WIB" is too long for a cell, so day and time. null when there is none. */
export function dueParts(iso: string | null): { day: string; time: string } | null {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  return { day: dayLabel(wibDateKey(at)), time: `${formatTime(at)} ${APP_TZ_LABEL}` };
}

/**
 * How long until the deadline: "in 3 d", "in 5 h", "< 1 h", "overdue 2 d". `urgent` when it is under a day away or past.
 * A done task has nothing left to wait for; a task with no deadline says so.
 */
export function dueIn(deadline: string | null, status: TaskStatus, now: Date): { text: string; urgent: boolean } {
  if (status === "done") return { text: "—", urgent: false };
  const at = deadline ? new Date(deadline).getTime() : NaN;
  if (Number.isNaN(at)) return { text: "No deadline", urgent: false };
  const ms = at - now.getTime();
  const abs = Math.abs(ms);
  const span = abs < HOUR ? "< 1 h" : abs < DAY ? `${Math.floor(abs / HOUR)} h` : `${Math.floor(abs / DAY)} d`;
  if (ms < 0) return { text: `overdue ${span}`, urgent: true };
  return { text: abs < HOUR ? span : `in ${span}`, urgent: ms < DAY };
}

/** The line under the greeting of My Task. */
export function tasksSubtitle(c: TaskCounts): string {
  const open = c.assigned + c.progress;
  const mine = `${plural(open, "post", "posts")} from Marketing ${open === 1 ? "is" : "are"} waiting for your design`;
  return `${open === 0 ? "No posts from Marketing are waiting for your design" : mine} · ${plural(c.waiting, "design", "designs")} done and waiting for Marketing · Only Admin approves content.`;
}

/** The line under the greeting of the dashboard. */
export function dashboardSubtitle(c: TaskCounts, drafts: number): string {
  const open = c.assigned + c.progress;
  const mine = open === 0 ? "No posts from Marketing are assigned to you" : `${plural(open, "post", "posts")} from Marketing ${open === 1 ? "is" : "are"} assigned to you`;
  const progress = c.progress === 0 ? "" : ` · ${c.progress} in progress`;
  const templates = drafts === 0 ? "" : ` · ${plural(drafts, "template", "templates")} still in Draft`;
  return `${mine}${progress}${templates}.`;
}

/** "Showing 5 of 5 tasks assigned to you · 2 done are waiting for Marketing" */
export function tasksFooter(shown: number, total: number, waiting: number): string {
  const waitingLine = waiting === 0 ? "" : ` · ${waiting} done ${waiting === 1 ? "is" : "are"} waiting for Marketing`;
  return `Showing ${shown} of ${plural(total, "task", "tasks")} assigned to you${waitingLine}`;
}

/** What Marketing's brief card heading says about the design. */
export function whoAssigned(t: Pick<TaskItem, "assignedBy">): string {
  return t.assignedBy ? shortName(t.assignedBy) : "Marketing";
}

/** The message that sits on top of a task page. */
export function taskBanner(t: Pick<TaskDetail, "status" | "figmaUrl" | "designerNote">): { tone: "info" | "success"; title: string; body: string } {
  if (t.status === "done") {
    return { tone: "success", title: "Sent to Marketing", body: "Marketing was told and can open your Figma link to export the design. The task is locked." };
  }
  if (t.status === "progress") {
    return { tone: "info", title: "Draft saved", body: "Your link and note are saved here and are not visible to Marketing. Mark as done sends them." };
  }
  return { tone: "info", title: "New task", body: "Open the brief, design it in Figma, then paste the Figma link on the right. Marketing is notified as soon as you mark it as done." };
}

/** Where the post stands, as the task page says it: the designer reads it and cannot change it. */
export function postStatusLine(postStatus: string, approvalStatus: string | null): string {
  if (postStatus === "draft" && approvalStatus === "pending") return "In review · waiting for Admin";
  if (postStatus === "draft" && approvalStatus === "rejected") return "Sent back for changes";
  if (postStatus === "draft") return "Draft · not submitted";
  if (postStatus === "pending") return "Approved · scheduled";
  if (postStatus === "published" || postStatus === "done") return "Published";
  return postStatus.charAt(0).toUpperCase() + postStatus.slice(1);
}

/** A line of a task's history. */
export function historyLine(kind: "sent" | "draft" | "done", by: string | null): string {
  if (kind === "sent") return by ? `Design request sent by ${shortName(by)}` : "Design request sent by Marketing";
  if (kind === "draft") return "Draft saved";
  return "Sent to Marketing";
}
