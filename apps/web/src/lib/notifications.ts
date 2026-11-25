// The notification drawer (docs/design/designer/drawer-notifications): what the API sends, and the words, groups and
// links of it. GET /notifications sends facts (what happened, to which post, who did it); the sentences are here.
import { apiFetch } from "./api";
import { shortName } from "./dashboard-format";
import { formatDate, formatTime, wibDateKey } from "./datetime";

export const NOTIFICATION_KINDS = ["task_assigned", "task_cancelled", "design_done", "review_submitted", "post_approved", "post_sent_back", "post_failed"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationItem {
  id: string;
  /** A kind this app does not know (a newer server) is shown plainly, not dropped. */
  kind: string;
  postId: string | null;
  title: string;
  thumbnail: string | null;
  by: string | null;
  note: string | null;
  read: boolean;
  at: string;
}

export interface NotificationList {
  items: NotificationItem[];
  unread: number;
}

export const fetchNotifications = () => apiFetch<NotificationList>("/notifications");
export const fetchUnreadCount = () => apiFetch<{ unread: number }>("/notifications/unread-count").then((r) => r.unread);
export const markNotificationRead = (id: string) => apiFetch(`/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
export const markAllNotificationsRead = () => apiFetch("/notifications/read-all", { method: "POST" });

type Tone = "neutral" | "success" | "danger" | "info";

interface Words {
  /** The pill: "Assigned", "Done", "Revision required". */
  pill: string;
  tone: Tone;
  line: (by: string, note: string | null) => string;
}

const KIND: Record<NotificationKind, Words> = {
  task_assigned: { pill: "Assigned", tone: "neutral", line: (by) => `Assigned by ${by} · Marketing` },
  task_cancelled: { pill: "Cancelled", tone: "danger", line: (by) => `${by} took the request back` },
  design_done: { pill: "Design done", tone: "success", line: (by) => `${by} sent the Figma link` },
  review_submitted: { pill: "In review", tone: "info", line: (by) => `${by} sent a post for your approval` },
  post_approved: { pill: "Approved", tone: "success", line: (by) => `${by} approved the post` },
  post_sent_back: { pill: "Revision required", tone: "danger", line: (by, note) => (note ? `${by}: ${note}` : `${by} sent the post back`) },
  post_failed: { pill: "Failed", tone: "danger", line: () => "The post could not be published" },
};

const isKnown = (kind: string): kind is NotificationKind => (NOTIFICATION_KINDS as readonly string[]).includes(kind);

/** The pill and the line under a title. Who did it is "Someone" when that person is gone. */
export function notificationWords(n: Pick<NotificationItem, "kind" | "by" | "note">): { pill: string; tone: Tone; line: string } {
  if (!isKnown(n.kind)) return { pill: "Update", tone: "neutral", line: "Something changed on this post" };
  const words = KIND[n.kind];
  return { pill: words.pill, tone: words.tone, line: words.line(shortName(n.by) || "Someone", n.note) };
}

/**
 * Where a click goes. A task is the designer's page, a post sent back or a design that came back is Marketing's editor, the
 * rest open the post in the Content List. A post that is gone has nowhere to go: null (the row only marks itself read).
 */
export function notificationHref(n: Pick<NotificationItem, "kind" | "postId">): string | null {
  if (n.kind === "task_cancelled") return "/tasks";
  if (!n.postId) return null;
  const id = encodeURIComponent(n.postId);
  if (n.kind === "task_assigned") return `/tasks/${id}`;
  if (n.kind === "design_done" || n.kind === "post_sent_back") return `/jobs/${id}/edit`;
  return `/jobs?open=${id}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "2 min ago · 13 Nov 2026, 10:24", "1 h ago · …", "Yesterday · 12 Nov 2026, 16:40": how long ago, then the WIB moment. */
export function notificationTime(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const moment = `${formatDate(at, { day: "numeric", month: "short", year: "numeric" })}, ${formatTime(at)}`;
  const ms = Math.max(0, now.getTime() - at.getTime());
  const days = daysBetween(at, now);
  if (days <= 0) {
    const ago = ms < MINUTE ? "Just now" : ms < HOUR ? `${Math.floor(ms / MINUTE)} min ago` : `${Math.floor(ms / HOUR)} h ago`;
    return `${ago} · ${moment}`;
  }
  return `${days === 1 ? "Yesterday" : `${days} d ago`} · ${moment}`;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((Date.parse(`${wibDateKey(to)}T00:00:00Z`) - Date.parse(`${wibDateKey(from)}T00:00:00Z`)) / (24 * HOUR));
}

/** The drawer's two groups: what happened on the WIB day of `now`, and everything before it. The order the server sent (newest first) is kept. */
export function groupNotifications(items: readonly NotificationItem[], now: Date): { today: NotificationItem[]; earlier: NotificationItem[] } {
  const today: NotificationItem[] = [];
  const earlier: NotificationItem[] = [];
  for (const n of items) (daysBetween(new Date(n.at), now) <= 0 ? today : earlier).push(n);
  return { today, earlier };
}

/** "4 items · 2 unread. Select one to open it." */
export function drawerSubtitle(total: number, unread: number): string {
  if (total === 0) return "Nothing yet. What happens on your posts and tasks shows up here.";
  return `${total} ${total === 1 ? "item" : "items"} · ${unread} unread. Select one to open it.`;
}

/** The number on the bell: nothing at zero, "99+" from a hundred. */
export const badgeText = (unread: number): string => (unread <= 0 ? "" : unread > 99 ? "99+" : String(unread));
