// The notification drawer every role has (docs/design/designer/drawer-notifications). A row stores only the facts: who it is
// for, what happened, which post and who did it. The title, picture and note are read from the post when the drawer opens, so
// a renamed post is renamed here too. The web writes the sentence for each kind (lib/notifications.ts there).
import { prisma } from "./prisma.js";
import { MANAGE_ROLES } from "./auth/withAuth.js";
import { contentOf, images, text, titleOf } from "./dashboardData.js";

export const NOTIFICATION_KINDS = [
  "design_revision",
  "task_assigned", // to the designer: Marketing sent a design request
  "task_cancelled", // to the designer: Marketing took it back
  "design_done", // to Marketing: the designer marked the design done
  "review_submitted", // to owner/admin: a post is waiting for approval
  "post_approved", // to the person who sent it for review
  "post_sent_back", // to the same person, with the reviewer's note
  "post_failed", // to the author: the post did not publish
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The drawer shows the latest of these; shortcut: nothing deletes old rows, so add retention when the table grows. */
export const NOTIFICATION_LIMIT = 50;
/** Owners and admins who hear about a post waiting for review: a workspace has a handful. */
const ADMINS_MAX = 100;

export interface NotifyRow {
  workspaceId: string;
  /** The recipient. */
  userId: string | null | undefined;
  kind: NotificationKind;
  postJobId?: string | null;
  /** Who did it: nobody is told about their own action. */
  actorId?: string | null;
}

/**
 * Writes the rows. A notification is never worth failing the action that caused it, so an error is logged and swallowed;
 * the callers `await` it so a test (and the order of writes) stays plain.
 */
export async function notify(rows: NotifyRow[]): Promise<void> {
  const data = rows.flatMap((r) =>
    r.userId && r.userId !== r.actorId
      ? [{ workspaceId: r.workspaceId, userId: r.userId, kind: r.kind, postJobId: r.postJobId ?? null, actorId: r.actorId ?? null }]
      : [],
  );
  if (data.length === 0) return;
  try {
    await prisma.notification.createMany({ data });
  } catch (err) {
    console.warn("[notifications] could not write:", (err as Error).message);
  }
}

/** The same fact, for each post, for every owner and admin of the workspace (posts waiting for approval). */
export async function notifyAdmins(workspaceId: string, kind: NotificationKind, postJobIds: string[], actorId: string): Promise<void> {
  if (postJobIds.length === 0) return;
  try {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId, role: { in: [...MANAGE_ROLES] } },
      take: ADMINS_MAX,
      select: { userId: true },
    });
    await notify(members.flatMap((m) => postJobIds.map((postJobId) => ({ workspaceId, userId: m.userId, kind, postJobId, actorId }))));
  } catch (err) {
    console.warn("[notifications] could not find the admins:", (err as Error).message);
  }
}

export interface NotificationRecord {
  id: string;
  kind: string;
  postJobId: string | null;
  readAt: Date | null;
  createdAt: Date;
  postJob: { content: string; reviewNote: string | null } | null;
  actor: { name: string } | null;
}

export interface NotificationView {
  id: string;
  kind: string;
  postId: string | null;
  /** The post's title now; a post that was deleted takes its notifications with it. */
  title: string;
  thumbnail: string | null;
  /** Who did it, when that is a person. */
  by: string | null;
  /** The reviewer's note for a post sent back. */
  note: string | null;
  read: boolean;
  /** ISO instant. */
  at: string;
}

export function toNotificationView(row: NotificationRecord): NotificationView {
  const content = row.postJob ? contentOf(row.postJob.content) : {};
  return {
    id: row.id,
    kind: row.kind,
    postId: row.postJobId,
    title: titleOf(content),
    thumbnail: images(content.mediaUrls)[0] ?? null,
    by: row.actor?.name ?? null,
    note: row.kind === "post_sent_back" ? text(row.postJob?.reviewNote).slice(0, 300) || null : null,
    read: row.readAt !== null,
    at: row.createdAt.toISOString(),
  };
}
