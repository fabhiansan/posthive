// Marketing's request to a designer for the design of one post (Path B of the Edit Content page).
// Pure helpers, so the rules are testable without the database. The routes are in routes/designRequests.ts.
import type { Prisma } from "@prisma/client";

/** What a request row needs to be shown: the assignee and whether they are still a designer of this workspace. */
export const designRequestSelect = (workspaceId: string) => ({
  id: true,
  status: true,
  deadline: true,
  brief: true,
  referenceUrl: true,
  sentAt: true,
  updatedAt: true,
  assignee: {
    select: {
      id: true,
      name: true,
      avatarUrl: true,
      workspaceMembers: { where: { workspaceId, role: "designer" }, select: { id: true } },
    },
  },
}) satisfies Prisma.DesignRequestSelect;

type DesignRequestRow = Prisma.DesignRequestGetPayload<{ select: ReturnType<typeof designRequestSelect> }>;

export interface DesignRequestView {
  id: string;
  status: string;
  /** The assignee; `active` is false when they left the design team, null when the account is gone. */
  assignee: { id: string; name: string; avatarUrl: string | null; active: boolean } | null;
  /** An ISO instant, or null: the deadline is optional. */
  deadline: string | null;
  brief: string;
  referenceUrl: string | null;
  sentAt: string | null;
  updatedAt: string;
}

export function toDesignRequestView(row: DesignRequestRow): DesignRequestView {
  const a = row.assignee;
  return {
    id: row.id,
    status: row.status,
    assignee: a ? { id: a.id, name: a.name, avatarUrl: a.avatarUrl, active: a.workspaceMembers.length > 0 } : null,
    deadline: row.deadline ? row.deadline.toISOString() : null,
    brief: row.brief,
    referenceUrl: row.referenceUrl,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type DeadlineProblem = "DEADLINE_PAST" | "DEADLINE_AFTER_PUBLISH";

export const DEADLINE_MESSAGE: Record<DeadlineProblem, string> = {
  DEADLINE_PAST: "The design deadline must be later than now.",
  DEADLINE_AFTER_PUBLISH: "The design deadline must be before the publishing date and time.",
};

/**
 * The deadline is optional; when there is one it must come after now and strictly before the moment the post goes out
 * (`publishAt` is null for a post with no date yet: then only "after now" applies). Instants, not days: a deadline at
 * 08:00 on the publishing day is fine for a post that goes out at 09:00.
 */
export function deadlineProblem(deadline: Date, now: Date, publishAt: Date | null): DeadlineProblem | null {
  if (deadline.getTime() <= now.getTime()) return "DEADLINE_PAST";
  if (publishAt && deadline.getTime() >= publishAt.getTime()) return "DEADLINE_AFTER_PUBLISH";
  return null;
}

/** Answer of every route that refuses to send a post out while its design is with the designer. */
export const IN_DESIGN = {
  error: "A design request is with the designer. Cancel it, or wait for the design, before sending this post on.",
  code: "IN_DESIGN",
} as const;

/** Part of the WHERE of a send, so a send and a Send Design Request at the same moment cannot both win. Matches a post with no request too. */
export const NOT_IN_DESIGN = { NOT: { designRequest: { is: { status: "sent" } } } } satisfies Prisma.PostJobWhereInput;
