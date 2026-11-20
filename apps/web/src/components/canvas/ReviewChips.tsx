"use client";

import { ArchiveIcon, CheckIcon, ClockIcon, MessageSquareWarningIcon, PencilIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ReviewStatus, ReviewSummary } from "@/lib/canvas";

/** What each answer to a submission is called, to a person. (An old, replaced one only shows in a history list.) */
export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  pending: "In review",
  approved: "Approved",
  changes_requested: "Changes requested",
  superseded: "Replaced",
};

const TONE: Record<ReviewStatus, "info" | "success" | "warning" | "default"> = { pending: "info", approved: "success", changes_requested: "warning", superseded: "default" };
const ICON: Record<ReviewStatus, React.ReactNode> = { pending: <ClockIcon />, approved: <CheckIcon />, changes_requested: <MessageSquareWarningIcon />, superseded: null };

/** The answer to ONE submission, as a chip. */
export function StatusChip({ status }: { status: ReviewStatus }) {
  return (
    <Badge variant={TONE[status]}>
      {ICON[status]} {REVIEW_LABEL[status]}
    </Badge>
  );
}

/**
 * A design's review state is two separate facts, shown as two separate elements: the answer to the newest submission (a chip,
 * which an edit never clears) and whether there is more work since (a badge). Both can show at once. Nothing shows for a
 * design that was never submitted and has nothing to say.
 */
export function ReviewChips({ review, archived = false }: { review: ReviewSummary; archived?: boolean }) {
  const { latestReviewStatus: status, hasChangesSinceSubmitted: changed } = review;
  if (!status && !archived) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {status && <StatusChip status={status} />}
      {changed && !archived && (
        <Badge variant="plain">
          <PencilIcon /> Unsubmitted changes
        </Badge>
      )}
      {archived && (
        <Badge variant="default">
          <ArchiveIcon /> Archived
        </Badge>
      )}
    </span>
  );
}

/** The designer's words on the newest answer, for the design's owner: "Changes requested: …". Nothing while it waits or was approved without one. */
export function ReviewComment({ review }: { review: ReviewSummary }) {
  if (review.latestReviewStatus !== "changes_requested" || !review.comment) return null;
  return (
    <p className="type-body-r-xs text-muted">
      <span className="type-body-sb-xs text-fg">Changes requested:</span> {review.comment}
    </p>
  );
}
