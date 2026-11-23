"use client";

import { useParams } from "next/navigation";
import { PostEditor } from "@/components/post-editor/PostEditor";

/** The Edit Content page of one post (docs/design/Edit Content · Path A, Path B). Add is /compose: the same editor. */
export default function EditPostPage() {
  const { id } = useParams<{ id: string }>();
  return <PostEditor key={id} jobId={id} />;
}
