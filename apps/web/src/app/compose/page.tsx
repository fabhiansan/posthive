"use client";

import { DesignReviewPrompt } from "@/components/canvas/DesignReviewPrompt";
import { PostEditor } from "@/components/post-editor/PostEditor";

/** Add Content: the same editor as /jobs/<id>/edit, for a post that does not exist yet. The Canvas review hand-off (?design=) lands here. */
export default function ComposePage() {
  return (
    <>
      <DesignReviewPrompt />
      <PostEditor />
    </>
  );
}
