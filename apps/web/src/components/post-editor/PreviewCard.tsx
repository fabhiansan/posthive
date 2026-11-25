"use client";

import { useState } from "react";
import { FilterChips } from "@/components/FilterChips";
import { PlatformPreview, type Account, type UploadedImage } from "@/components/PlatformPreview";
import { Card } from "@/components/ui/card";
import { assetUrl } from "@/lib/api";
import { platformLabel } from "@/lib/platforms";
import { EDITOR_PLATFORMS, formatLine, isVideoUrl, type PostForm } from "@/lib/post-editor";
import type { DesignRequestView } from "@/lib/jobTypes";
import { designLine, requestLine } from "@/lib/post-editor";

type Props = {
  form: PostForm;
  accounts: Account[];
  workspaceName: string;
  /** The category's template, for the summary. */
  templateName: string | null;
  request: DesignRequestView | null;
};

const ROW = "grid grid-cols-[5.5rem_1fr] gap-3 py-1.5 type-body-r-xs";

/** Card D: how the post will look on each channel, live, and a short summary of what it is made of. */
export function PreviewCard({ form, accounts, workspaceName, templateName, request }: Props) {
  const [platform, setPlatform] = useState<string>(EDITOR_PLATFORMS[0]);
  const tabs = EDITOR_PLATFORMS.filter((p) => accounts.some((a) => a.platform === p && form.accountIds.includes(a.id)));
  const active = tabs.includes(platform as never) ? platform : (tabs[0] ?? platform);
  // the ticked account of that platform, else a stand-in named after the workspace so the card still shows how it will look
  const account: Account = accounts.find((a) => a.platform === active && form.accountIds.includes(a.id)) ?? { id: "preview", platform: active, displayName: workspaceName };
  const images = form.mediaUrls.filter((u) => !isVideoUrl(u));
  const media: UploadedImage[] = images.map((url, i) => ({ url, previewUrl: assetUrl(url), name: `File ${i + 1}` }));
  const channels = tabs.map(platformLabel).join(" · ");
  const design = images.length > 0 ? `${images.length} ${images.length === 1 ? "file" : "files"}` : request ? (request.status === "done" ? designLine(request) : `Requested · ${requestLine(request)}`) : "—";

  return (
    <Card className="gap-4 border-0 p-5" role="region" aria-labelledby="preview-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="preview-heading" className="type-body-sb-m text-fg">D · Content preview</h2>
        <p className="type-body-r-xs text-muted">Live · reflects latest edits</p>
      </div>

      <FilterChips
        label="Preview channel"
        value={active}
        onChange={setPlatform}
        options={EDITOR_PLATFORMS.map((p) => ({ value: p, label: platformLabel(p) }))}
        itemClassName="rounded-full px-3 py-1"
      />

      <div className="min-w-0 overflow-hidden rounded-xl">
        <PlatformPreview account={account} text={form.text} commentText="" mediaItems={media} igMediaType="post" />
        {media.length === 0 && <p className="mt-2 rounded-xl border border-dashed border-border px-4 py-6 text-center type-body-r-xs text-muted">Design preview. Choose a template or upload a design.</p>}
      </div>

      <dl className="divide-y divide-border rounded-xl bg-red-50/40 px-4 py-2">
        <div className={ROW}><dt className="text-muted">Title</dt><dd className="min-w-0 break-words text-fg">{form.title || "—"}</dd></div>
        <div className={ROW}><dt className="text-muted">Format</dt><dd className="text-fg">{formatLine(form.format, images.length) ?? "—"}</dd></div>
        <div className={ROW}><dt className="text-muted">Platform</dt><dd className="text-fg">{channels || "—"}</dd></div>
        <div className={ROW}><dt className="text-muted">Design</dt><dd className="min-w-0 break-words text-fg">{design}</dd></div>
        <div className={ROW}><dt className="text-muted">Template</dt><dd className="text-fg">{templateName ?? "—"}</dd></div>
      </dl>
    </Card>
  );
}
