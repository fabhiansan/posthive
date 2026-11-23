// What every route that promotes a draft to a scheduled post checks first: the web page's schedule, the public REST API's
// approve and the MCP approve_draft. One rule in one place, so a way of scheduling cannot skip it.
import { IN_DESIGN } from "./designRequest.js";

export const NO_ACCOUNT = { error: "Pick at least one account before this post is scheduled.", code: "NO_ACCOUNT" } as const;

export interface PromotableJob {
  approvalStatus: string | null;
  designRequest?: { status: string } | null;
  /** Any list of the post's targets; only whether it is empty matters. */
  targets: readonly unknown[];
}

/**
 * Why a draft cannot be scheduled right now (null: it can).
 * - Its design is with the designer. Approving a post that is already IN REVIEW is not affected: the reviewer decides that.
 * - It has no account. A draft may have none (a plan import, the editor page), but a post with no target is "published" to nothing.
 */
export function promoteRefusal(job: PromotableJob): { status: 409 | 422; body: typeof IN_DESIGN | typeof NO_ACCOUNT } | null {
  if (job.approvalStatus !== "pending" && job.designRequest?.status === "sent") return { status: 409, body: IN_DESIGN };
  if (job.targets.length === 0) return { status: 422, body: NO_ACCOUNT };
  return null;
}
