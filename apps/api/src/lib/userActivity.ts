// "Your activity" on the profile page: what the signed-in person did this quarter. Where each number comes from is
// written next to it, so a reader can follow it back to a column.
import type { Prisma } from "@prisma/client";
import { STATUS_GROUPS } from "./jobFilters.js";
import { quarterOf, wibKey, wibStart } from "./dashboardData.js";

type Where = Prisma.PostJobWhereInput;

export interface ActivityRow {
  /** The word the page keys its line on. */
  id: "imported" | "sent" | "approved" | "scheduled" | "published" | "reviewed" | "sentBack" | "templates";
  count: number;
  /** Only "published" says where: the channels the person's published posts of this quarter went to. */
  channels?: string[];
}

export interface UserActivity {
  /** "Q4 2026" */
  quarter: string;
  /** The design team sees what it reviewed; owner, admin and Marketing see their own posts. */
  kind: "maker" | "reviewer";
  rows: ActivityRow[];
}

/** The quarter of a day, as the instants it starts and ends (WIB). */
export function quarterRange(now: Date): { label: string; from: Date; to: Date } {
  const q = quarterOf(wibKey(now));
  return { label: q.label, from: wibStart(q.start), to: wibStart(q.end) };
}

/** The where-clauses behind each number of a person's own posts (the maker's side), in one workspace. */
export function makerWhere(workspaceId: string, userId: string, range: { from: Date; to: Date }) {
  const mine: Where = { workspaceId, userId };
  const inQuarter = (field: "createdAt" | "submittedAt" | "reviewedAt" | "scheduledFor") => ({ [field]: { gte: range.from, lt: range.to } }) as Where;
  return {
    // came in with a plan file: only an import sets importKey
    imported: { ...mine, importKey: { not: null }, ...inQuarter("createdAt") } as Where,
    // the person sent it for review (not the author: a colleague may have sent a post the head imported)
    sent: { workspaceId, submittedById: userId, ...inQuarter("submittedAt") } as Where,
    // their post was approved this quarter
    approved: { ...mine, approvalStatus: "approved", ...inQuarter("reviewedAt") } as Where,
    // waiting for its time
    scheduled: { ...mine, status: { in: [...STATUS_GROUPS.pending] } } as Where,
    // went out this quarter (by its date)
    published: { ...mine, status: { in: [...STATUS_GROUPS.done] }, ...inQuarter("scheduledFor") } as Where,
  };
}

/** The reviewer's side: what they answered and added this quarter. */
export function reviewerWhere(workspaceId: string, userId: string, range: { from: Date; to: Date }) {
  const answered = (approvalStatus: "approved" | "rejected"): Where => ({
    workspaceId,
    reviewedByUserId: userId,
    approvalStatus,
    reviewedAt: { gte: range.from, lt: range.to },
  });
  return {
    reviewed: answered("approved"),
    // still waiting for the maker's change: a rejected post that was edited loses its answer, so this counts what is still open
    sentBack: answered("rejected"),
    templates: { workspaceId, userId, createdAt: { gte: range.from, lt: range.to } } as Prisma.TemplateWhereInput,
  };
}

/** Only the design team makes no posts of its own, so only it is shown its reviews. Owner and admin do both and are shown the Marketing design's card. */
export const isReviewerOnly = (role: string | null | undefined): boolean => role === "designer";
