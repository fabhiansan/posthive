"use client";

import { useState, type KeyboardEvent } from "react";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { assetUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/datetime";
import { platformLabel } from "@/lib/platforms";
import { StatusPill } from "./StatusPill";
import type { ContentRow } from "./types";

type Props = {
  row: ContentRow;
  /** "publish": today's posts that are out of draft, with the channel and time beside the status. "task": today's drafts, with the due time under them. */
  kind: "publish" | "task";
  /** The row was clicked: open the post in the drawer, where the person does what the post needs (edit, review, retry). Without it the row is plain text. */
  onOpen?: (id: string) => void;
};

/** The small print under a post: where it stands today, in words. A draft is a task and never a publish, so it has no line in the publish list. */
function noteOf(row: ContentRow, kind: Props["kind"]): string | null {
  const time = row.publishAt ? `${formatTime(new Date(row.publishAt))} WIB` : null;
  if (kind === "task") {
    // what the draft is waiting for: the stage is the pill, this is the next step
    const next = row.production === "review" ? "Waiting for approval" : row.production === "changes" ? "Changes requested" : "Not sent for review yet";
    return [next, time && `Due ${time}`, row.channels[0] && platformLabel(row.channels[0])].filter(Boolean).join(" · ");
  }
  if (row.publication === "published") return "Published today";
  if (row.publication === "failed") return "Publishing failed · needs a retry";
  return "Approved · ready to publish";
}

/**
 * One post in a side panel: its picture (or its channel's icon), its title on one line, its status as a
 * pill and a line of small print. Everything is allowed to shrink (min-w-0) and nothing wraps below the
 * picture, so a title as long as a paragraph or an address with no spaces is cut with an ellipsis and
 * cannot widen the panel.
 */
export function PostLine({ row, kind, onOpen }: Props) {
  // a picture that cannot be loaded (a deleted file) falls back to the channel's icon
  const [broken, setBroken] = useState(false);
  // As in the design, a scheduled post reads "Approved" (the small print says it is scheduled); only an outcome replaces it
  const status = row.publication === "published" || row.publication === "failed" ? row.publication : row.production;
  const channel = row.channels[0];
  const note = noteOf(row, kind);
  const time = row.publishAt ? `${formatTime(new Date(row.publishAt))} WIB` : null;

  // A row that opens its post: Tab reaches it, Enter and Space press it, and it is named for what it opens (the same as the
  // rows of the content table). It is not a <button>: its title, pill and small print are blocks (div, p), which a button may
  // not hold. Nothing inside it can take focus, so a key can only come from the row itself.
  const opens = onOpen
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-label": `Open ${row.title}`,
        onClick: () => onOpen(row.id),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(row.id);
          }
        },
      }
    : {};

  return (
    <Item
      size="sm"
      {...opens}
      // -mx-2 p-2 gives the hover tint room around the row without moving its text
      className={cn("flex-nowrap items-start gap-3 p-0", onOpen && "-mx-2 cursor-pointer p-2 hover:bg-neutral-100/60")}
    >
      <ItemMedia variant="icon" className="size-12 translate-y-0 self-start overflow-hidden rounded-lg border-0 bg-bg">
        {row.thumbnail && !broken ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={assetUrl(row.thumbnail)} alt="" loading="lazy" className="size-full object-cover" onError={() => setBroken(true)} />
        ) : channel ? (
          <PlatformIcon platform={channel} size={22} />
        ) : (
          <span aria-hidden="true" className="text-muted-foreground">—</span>
        )}
      </ItemMedia>
      <ItemContent className="min-w-0 gap-1">
        <ItemTitle className="w-full min-w-0 max-w-full">
          <span className="truncate" title={row.title}>
            {row.title}
          </span>
        </ItemTitle>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <StatusPill status={status} solid={status === "approved"} check={status === "approved"} />
          {kind === "publish" && (channel || time) && (
            <span className="min-w-0 truncate type-body-r-xs text-muted-foreground">
              {[channel && platformLabel(channel), time].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        {note && <p className="min-w-0 truncate type-body-r-xxs text-muted-foreground">{note}</p>}
      </ItemContent>
    </Item>
  );
}
