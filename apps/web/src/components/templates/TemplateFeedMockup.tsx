"use client";

import { useState } from "react";
import { BookmarkIcon, ChevronLeftIcon, ChevronRightIcon, HeartIcon, ImageIcon, MessageCircleIcon, SendIcon } from "lucide-react";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { initialsOf } from "@/lib/dashboard-format";
import { platformLabel } from "@/lib/platforms";
import { fileHref, type DesignTemplate, type TemplatePlatform } from "@/lib/templates";

type Props = {
  template: Pick<DesignTemplate, "category" | "format" | "platforms" | "previewUrl" | "slideImages" | "captionGuideline">;
  /** Whose feed the post is shown in: the workspace's name. */
  account: string;
};

// Story and reel cover are tall; everything else is the 4:5 feed picture.
const TALL = new Set(["story", "reel_cover"]);

/**
 * The template as it will look in a feed: the platform's post frame around the design, and the slides one by one. It shows the
 * design only; the caption line says Marketing writes it (the guideline is on its own card), so nothing here can be taken for a
 * caption that will be posted. Platforms are the template's own (none set: Instagram).
 */
export function TemplateFeedMockup({ template: t, account }: Props) {
  const platforms: TemplatePlatform[] = t.platforms.length > 0 ? t.platforms : ["instagram"];
  const [platform, setPlatform] = useState<TemplatePlatform>(platforms[0]);
  const [at, setAt] = useState(0);

  // the slides, else the preview, else nothing yet
  const images = t.slideImages.length > 0 ? t.slideImages.map((s) => s.url) : t.previewUrl ? [t.previewUrl] : [];
  const index = Math.min(at, Math.max(0, images.length - 1));
  const shown = platforms.includes(platform) ? platform : platforms[0];
  const many = images.length > 1;

  return (
    <div className="flex flex-col items-center gap-4">
      {platforms.length > 1 && (
        <div role="group" aria-label="Preview as" className="flex gap-2 self-start">
          {platforms.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={p === shown}
              onClick={() => setPlatform(p)}
              className={cn("chip px-3 py-1 type-body-m-xs", p === shown && "chip-active")}
            >
              {platformLabel(p)}
            </button>
          ))}
        </div>
      )}

      <figure aria-label={`${platformLabel(shown)} post preview`} className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-surface">
        <figcaption className="flex items-center gap-3 p-3">
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-500 type-body-sb-xs text-neutral-950">{initialsOf(account)}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate type-body-sb-s text-fg">{account}</span>
            <span className="truncate type-body-r-xxs text-muted">Template preview · sample</span>
          </span>
          <PlatformIcon platform={shown} size={20} />
        </figcaption>

        <div className={cn("relative flex items-center justify-center bg-neutral-100", TALL.has(t.format ?? "") ? "aspect-9/16" : "aspect-4/5")}>
          {images.length > 0 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileHref(images[index])} alt={`${t.category}${many ? `, slide ${index + 1} of ${images.length}` : ""}`} className="size-full object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-muted">
              <ImageIcon aria-hidden="true" className="size-8" />
              <p className="type-body-sb-s text-fg">No preview image yet</p>
              <p className="type-body-r-xs">Add a preview image or the slides in Edit template.</p>
            </div>
          )}
          {many && (
            <>
              <Button type="button" variant="secondary" size="icon-sm" aria-label="Previous slide" disabled={index === 0} onClick={() => setAt(index - 1)} className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full">
                <ChevronLeftIcon />
              </Button>
              <Button type="button" variant="secondary" size="icon-sm" aria-label="Next slide" disabled={index === images.length - 1} onClick={() => setAt(index + 1)} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full">
                <ChevronRightIcon />
              </Button>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2 p-3">
          {many && (
            <div className="flex items-center justify-between">
              <span aria-hidden="true" className="flex items-center gap-1">
                {images.map((url, i) => (
                  <span key={url} className={cn("size-1.5 rounded-full", i === index ? "bg-neutral-900" : "border border-neutral-500")} />
                ))}
              </span>
              <span className="type-body-r-xs text-muted" aria-live="polite">{index + 1} / {images.length}</span>
            </div>
          )}
          <div aria-hidden="true" className="flex items-center gap-3 text-neutral-700">
            <HeartIcon className="size-5" />
            <MessageCircleIcon className="size-5" />
            <SendIcon className="size-5" />
            <BookmarkIcon className="ml-auto size-5" />
          </div>
          <p className="type-body-r-xs text-muted">Caption written by Marketing, following the caption guideline.</p>
        </div>
      </figure>
    </div>
  );
}
