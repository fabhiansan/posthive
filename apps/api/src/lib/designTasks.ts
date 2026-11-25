// The designer's side of a design request: "My Task". A task is a DesignRequest that Marketing sent (status sent) or that
// the designer answered (status done), seen only by the designer it was sent to. Pure, so the rules are tested without a
// database; routes/designTasks.ts runs the queries. Like the other list views, a post leaves the server only as these
// fields: the content JSON never does.
import type { Prisma, PrismaClient } from "@prisma/client";
import { channelsOf, safeLink } from "./contentList.js";
import { contentOf, images, pillarOf, plainDraft, realDate, text, titleOf } from "./dashboardData.js";

/** Rows in a page of the My Task table, as the design draws it. */
export const TASK_PAGE_SIZE = 10;
/** Tasks the dashboard lists before "View all". */
export const DASHBOARD_TASK_LIMIT = 5;
/** Longest a designer's note to Marketing, and the brief a row shows. */
export const NOTE_MAX = 2000;
const BRIEF_PREVIEW = 160;
const CAPTION_MAX = 5000;

export const TASK_TABS = ["all", "assigned", "progress", "done"] as const;
export type TaskTab = (typeof TASK_TABS)[number];
export const isTaskTab = (value: unknown): value is TaskTab => TASK_TABS.includes(value as TaskTab);

/** assigned: nothing saved yet. progress: the designer saved a link or a note. done: sent to Marketing. */
export type TaskStatus = "assigned" | "progress" | "done";

export function taskStatusOf(r: { status: string; figmaUrl: string | null; designerNote: string | null }): TaskStatus {
  if (r.status === "done") return "done";
  return r.figmaUrl || r.designerNote ? "progress" : "assigned";
}

/**
 * The requests behind each tab, for ONE designer in ONE workspace. A saved draft stores null, never "", so "nothing saved"
 * is `null` here. The tabs partition the open and done tasks: assigned + progress + done is all.
 */
export const taskBase = (workspaceId: string, assigneeId: string): Prisma.DesignRequestWhereInput => ({ workspaceId, assigneeId });

export function taskTabWhere(tab: TaskTab): Prisma.DesignRequestWhereInput {
  switch (tab) {
    case "assigned":
      return { status: "sent", figmaUrl: null, designerNote: null };
    case "progress":
      return { status: "sent", OR: [{ figmaUrl: { not: null } }, { designerNote: { not: null } }] };
    case "done":
      return { status: "done" };
    default:
      return { status: { in: ["sent", "done"] } };
  }
}

/** Open tasks soonest deadline first (none last); the Done tab newest first. */
export function taskOrder(tab: TaskTab): Prisma.DesignRequestOrderByWithRelationInput[] {
  if (tab === "done") return [{ doneAt: "desc" }, { id: "asc" }];
  // "sent" sorts after "done", so descending puts the open tasks first in All
  return [{ status: "desc" }, { deadline: { sort: "asc", nulls: "last" } }, { id: "asc" }];
}

export interface TaskCounts {
  assigned: number;
  progress: number;
  done: number;
  /** Done tasks whose post Marketing has not sent for review yet. */
  waiting: number;
}

/** The numbers on the cards. Four counts on the (workspace, assignee, status) index. */
export async function countTasks(db: Pick<PrismaClient, "designRequest">, workspaceId: string, assigneeId: string): Promise<TaskCounts> {
  const base = taskBase(workspaceId, assigneeId);
  const [assigned, progress, done, waiting] = await Promise.all([
    db.designRequest.count({ where: { ...base, ...taskTabWhere("assigned") } }),
    db.designRequest.count({ where: { ...base, ...taskTabWhere("progress") } }),
    db.designRequest.count({ where: { ...base, ...taskTabWhere("done") } }),
    db.designRequest.count({ where: { ...base, status: "done", postJob: plainDraft } }),
  ]);
  return { assigned, progress, done, waiting };
}

export const TASK_SELECT = {
  id: true,
  status: true,
  deadline: true,
  brief: true,
  referenceUrl: true,
  sentAt: true,
  doneAt: true,
  updatedAt: true,
  figmaUrl: true,
  designerNote: true,
  createdById: true,
  createdBy: { select: { name: true } },
  postJob: {
    select: {
      id: true,
      status: true,
      approvalStatus: true,
      scheduledFor: true,
      content: true,
      userId: true,
      user: { select: { name: true } },
      targets: { select: { account: { select: { platform: true, displayName: true } } } },
    },
  },
} satisfies Prisma.DesignRequestSelect;

export type TaskRow = Prisma.DesignRequestGetPayload<{ select: typeof TASK_SELECT }>;

export interface TaskItem {
  /** The post's id: the task page is /tasks/<postId>. */
  postId: string;
  title: string;
  thumbnail: string | null;
  pillar: string | null;
  format: "single" | "carousel" | null;
  status: TaskStatus;
  /** Marketing person who sent it; the post's author when that was not recorded. */
  assignedBy: string | null;
  /** ISO instants, or null. */
  deadline: string | null;
  sentAt: string | null;
  doneAt: string | null;
  /** When the post goes out; null for a post with no date. */
  scheduledFor: string | null;
  channels: string[];
  /** The start of the brief. */
  brief: string;
}

export function toTaskItem(row: TaskRow): TaskItem {
  const content = contentOf(row.postJob.content);
  return {
    postId: row.postJob.id,
    title: titleOf(content),
    thumbnail: images(content.mediaUrls)[0] ?? null,
    pillar: pillarOf(content),
    format: content.format === "single" || content.format === "carousel" ? content.format : null,
    status: taskStatusOf(row),
    assignedBy: row.createdBy?.name ?? row.postJob.user?.name ?? null,
    deadline: row.deadline ? row.deadline.toISOString() : null,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    // the MCP and the public API save a post with no date as the epoch: that is "no date", not 1 January 1970
    scheduledFor: realDate(row.postJob.scheduledFor)?.toISOString() ?? null,
    channels: channelsOf(content, row.postJob.targets),
    brief: row.brief.slice(0, BRIEF_PREVIEW),
  };
}

/** A link cell from the plan or the editor: an address the browser may open, else the text it holds (cut short). */
function linkOrText(value: unknown): { link: string | null; text: string } {
  const link = safeLink(value);
  return { link, text: link ? "" : text(value).slice(0, 300) };
}

export interface TaskDetail extends TaskItem {
  /** The whole caption (cut at a few thousand characters) and its length. */
  caption: string;
  captionLength: number;
  category: string | null;
  /** What Marketing wrote about the design. */
  briefFull: string;
  referenceUrl: string | null;
  /** Read-only facts of the post, for the "Content information" card. */
  postStatus: string;
  approvalStatus: string | null;
  accounts: { platform: string; displayName: string }[];
  copywriting: { link: string | null; text: string };
  assets: { link: string | null; text: string };
  /** The designer's own saved link and note while the task is open; the answer once it is done. */
  figmaUrl: string | null;
  designerNote: string | null;
  history: { kind: "sent" | "draft" | "done"; at: string }[];
}

export function toTaskDetail(row: TaskRow): TaskDetail {
  const content = contentOf(row.postJob.content);
  const item = toTaskItem(row);
  const caption = text(content.text);
  const history: TaskDetail["history"] = [];
  if (row.sentAt) history.push({ kind: "sent", at: row.sentAt.toISOString() });
  // the request is the designer's alone while it is sent, so its last change is the last saved draft
  if (item.status === "progress") history.push({ kind: "draft", at: row.updatedAt.toISOString() });
  if (row.doneAt) history.push({ kind: "done", at: row.doneAt.toISOString() });
  return {
    ...item,
    brief: row.brief.slice(0, BRIEF_PREVIEW),
    briefFull: row.brief,
    referenceUrl: safeLink(row.referenceUrl),
    caption: caption.slice(0, CAPTION_MAX),
    captionLength: caption.length,
    category: text(content.category).slice(0, 60) || null,
    postStatus: row.postJob.status,
    approvalStatus: row.postJob.approvalStatus,
    accounts: row.postJob.targets.flatMap((t) => (t.account ? [t.account] : [])),
    copywriting: linkOrText(content.designCopy),
    assets: linkOrText(content.assetNotes),
    figmaUrl: row.figmaUrl,
    designerNote: row.designerNote,
    history,
  };
}

export interface TaskActivity {
  kind: "assigned" | "sent" | "template";
  /** ISO instant. */
  at: string;
  /** Who assigned it, or uploaded the template. */
  by: string | null;
  mine: boolean;
  /** The post's title, or the template's name. */
  title: string;
  /** Only for a template: the pillar it was added to. */
  pillar: string | null;
}

export interface TaskActivitySources {
  /** The designer's requests, newest sends first, and newest answers first. */
  assigned: { sentAt: Date | null; createdBy: { name: string } | null; postJob: { content: string } }[];
  answered: { doneAt: Date | null; postJob: { content: string } }[];
  templates: { name: string; pillar: string | null; createdAt: Date; userId: string; user: { name: string } | null }[];
}

/**
 * The newest events since `since`, built from what the rows already hold (nothing logs events): a task assigned to the
 * viewer, a design the viewer sent to Marketing, a template. A task Marketing cancelled has lost its send time, so it is
 * no event. Newest first.
 */
export function taskActivities(viewerId: string, src: TaskActivitySources, since: Date, limit: number): TaskActivity[] {
  const events: (TaskActivity & { time: number })[] = [];
  const push = (e: Omit<TaskActivity, "at">, at: Date | null) => {
    if (at && at >= since) events.push({ ...e, at: at.toISOString(), time: at.getTime() });
  };
  const title = (row: { content: string }) => titleOf(contentOf(row.content));
  for (const r of src.assigned) push({ kind: "assigned", by: r.createdBy?.name ?? null, mine: false, title: title(r.postJob), pillar: null }, r.sentAt);
  for (const r of src.answered) push({ kind: "sent", by: null, mine: true, title: title(r.postJob), pillar: null }, r.doneAt);
  for (const t of src.templates) push({ kind: "template", by: t.user?.name ?? null, mine: t.userId === viewerId, title: t.name, pillar: t.pillar }, t.createdAt);
  return events
    .sort((a, b) => b.time - a.time)
    .slice(0, limit)
    .map(({ time: _time, ...event }) => event);
}
