import { StatusChip } from "@/components/content-list/StatusChip";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Card } from "@/components/ui/card";
import { approvalLabel, filterOf, pillOf, publishingLabel, statusOfPost } from "@/lib/content-list";
import { formatTime } from "@/lib/datetime";
import { platformLabel } from "@/lib/platforms";
import { requestLine, type StoredContent } from "@/lib/post-editor";
import type { DesignRequestView } from "@/lib/jobTypes";

type Props = {
  /** Null while the post is new (not saved yet). */
  post: { status: string; approvalStatus: string | null; updatedAt?: string } | null;
  stored: StoredContent;
  request: DesignRequestView | null;
  /** The platforms of the ticked channels. */
  channels: string[];
};

/** The strip under the title: where the post stands, when it was last saved, where it came from, and its channels. */
export function StatusStrip({ post, stored, request, channels }: Props) {
  const now = post ?? { status: "draft", approvalStatus: null };
  const filter = filterOf(now);
  const meta = [
    post?.updatedAt ? `Last saved ${formatTime(new Date(post.updatedAt))}` : "Not saved yet",
    typeof stored.sourceRow === "number" ? `Source: row ${stored.sourceRow}` : null,
    "fields marked * are required to submit",
  ].filter(Boolean);
  return (
    <Card className="flex-row flex-wrap items-center gap-x-3 gap-y-2 border-0 px-5 py-4">
      <StatusChip status={pillOf(now)} label={`Content: ${statusOfPost(now)}`} />
      <StatusChip status={filter === "review" ? "review" : filter === "rejected" ? "changes" : "brief"} label={`Approval: ${approvalLabel(now)}`} />
      <StatusChip status={filter === "pending" ? "scheduled" : filter === "done" ? "published" : filter === "failed" ? "failed" : "brief"} label={`Publishing: ${publishingLabel(now)}`} />
      {request && <StatusChip status="design" label={`Design requested · ${requestLine(request)}`} />}
      <p className="min-w-0 type-body-r-xs text-muted">{meta.join(" · ")}</p>
      {channels.length > 0 && (
        <span className="ml-auto flex items-center gap-2" aria-label={`Channels: ${channels.map(platformLabel).join(", ")}`}>
          {channels.map((c) => (
            <span key={c} title={platformLabel(c)} className="flex size-9 items-center justify-center rounded-lg bg-neutral-50">
              <PlatformIcon platform={c} size={20} />
            </span>
          ))}
        </span>
      )}
    </Card>
  );
}
