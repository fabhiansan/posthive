"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canSubmitReview, type ReviewSummary } from "@/lib/canvas";
import { ReviewChips, ReviewComment } from "./ReviewChips";

/** Where Compose takes the hand-off: it asks the person to confirm (DesignReviewPrompt), then submits. */
export const reviewHref = (designId: string) => `/compose?design=${encodeURIComponent(designId)}`;

/**
 * The editor's review controls: the two facts about the design's review (an answer chip and an "Unsubmitted changes" badge,
 * separate and both possible at once), the designer's comment when changes were requested, and "Review" when there is
 * something to submit. "Review" saves first; if the save cannot be completed it stays on the page, because submitting
 * names the saved version and nothing else.
 */
export function ReviewAction({ designId, review, flush }: { designId: string; review: ReviewSummary; flush: () => Promise<boolean> }) {
  const router = useRouter();
  const [going, setGoing] = useState(false);
  const can = canSubmitReview(review);

  async function go() {
    setGoing(true);
    try {
      if (await flush()) router.push(reviewHref(designId));
    } finally {
      setGoing(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="hidden min-w-0 flex-col items-end gap-0.5 md:flex">
        <ReviewChips review={review} />
        <ReviewComment review={review} />
      </div>
      <Button size="sm" onClick={() => void go()} disabled={!can || going} title={can ? undefined : "Nothing has changed since you last submitted this design."}>
        <SendIcon /> <span className="max-sm:sr-only">Review</span>
      </Button>
    </div>
  );
}
