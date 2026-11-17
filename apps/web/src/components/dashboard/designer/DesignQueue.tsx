"use client";

import { useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { ImageIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { assetUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { initialsOf, shortName } from "@/lib/dashboard-format";
import { formatLabel, publishLines, queueFooter, versionLabel, waitingLabel, type ApiQueuePost } from "@/lib/designer-dashboard";
import { DesignPanel } from "./DesignPanel";

type Props = {
  posts: ApiQueuePost[];
  /** Every design waiting, not only these rows. */
  pending: number;
  revision: number;
  approved: number;
  now: Date;
  /** The row was clicked: open the post in the drawer. */
  onOpen: (id: string) => void;
  /** "Review design": open the review dialog at once. */
  onReview: (id: string) => void;
};

const COLUMNS = ["Thumbnail", "Content title", "Content pillar", "Content format", "Submitted by", "Waiting", "Publish date", "Approval status", "Action"];

/** A picture that cannot be shown (a deleted file) is a quiet olive tile with an icon, not a broken image. */
function Thumb({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex h-14 w-11 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-neutral-700">
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={assetUrl(src)} alt="" loading="lazy" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <ImageIcon aria-hidden="true" className="size-4 text-neutral-300" />
      )}
    </div>
  );
}

/**
 * "Pending Design Approvals": the designs that have waited longest for the design team's answer. A row opens the post; the
 * button opens the review. Every row says "Pending review": nothing records that someone started looking at it.
 */
export function DesignQueue({ posts, pending, revision, approved, now, onOpen, onReview }: Props) {
  // a row is a button: reachable by Tab, named for what it opens. Keys count only when the row itself has focus, so Enter on the button inside is the button's
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(id);
    }
  };

  return (
    <DesignPanel
      title="Pending Design Approvals"
      action={
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="type-body-r-xs text-neutral-500">Needs your action · longest waiting first</span>
          <Button asChild variant="secondary" size="sm" className="rounded-full border-neutral-500 px-3 text-neutral-400">
            <Link href="/jobs?filter=review">View all</Link>
          </Button>
        </div>
      }
    >
      <div className="overflow-x-auto rounded-2xl border border-neutral-200">
        <Table aria-label="Designs waiting for review" className="min-w-240 type-body-r-xs">
          <TableHeader className="[&_tr]:border-neutral-50">
            <TableRow className="bg-neutral-50 hover:bg-neutral-50">
              {COLUMNS.map((name) => (
                <TableHead key={name} className="h-9 type-body-r-xs text-neutral-500">
                  {name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {posts.map((post) => {
              const waiting = waitingLabel(post.submittedAt, now);
              const publish = publishLines(post.scheduledFor, now);
              const who = shortName(post.submittedBy);
              return (
                <TableRow
                  key={post.id}
                  tabIndex={0}
                  aria-label={`Open ${post.title}`}
                  onClick={() => onOpen(post.id)}
                  onKeyDown={(e) => onKey(e, post.id)}
                  className="cursor-pointer border-neutral-50 bg-surface outline-none hover:bg-brand-50 focus-visible:bg-brand-50 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
                >
                  <TableCell className="w-14 py-3 pr-0">
                    <Thumb src={post.thumbnail} />
                  </TableCell>
                  <TableCell className="py-3">
                    <p className="max-w-60 min-w-40 truncate type-body-m-xs text-neutral-950" title={post.title}>
                      {post.title}
                    </p>
                    {/* a design sent back and sent again reads dark; a first send reads quiet */}
                    <p className={cn("mt-1", post.submitCount > 1 ? "text-neutral-950" : "text-neutral-950/60")}>{versionLabel(post.submitCount)}</p>
                  </TableCell>
                  <TableCell className="py-3 whitespace-nowrap text-neutral-950">{post.pillar ?? "—"}</TableCell>
                  <TableCell className="py-3 whitespace-nowrap text-neutral-950">{formatLabel(post.media)}</TableCell>
                  <TableCell className="py-3">
                    <div className="flex items-center gap-2">
                      <Avatar className="size-6">
                        <AvatarFallback className="bg-brand-500 text-neutral-950">{initialsOf(post.submittedBy)}</AvatarFallback>
                      </Avatar>
                      <span className="whitespace-nowrap text-neutral-950">{who || "—"}</span>
                    </div>
                  </TableCell>
                  <TableCell className={cn("py-3 whitespace-nowrap", waiting.late ? "text-red-500" : "text-neutral-950")}>{waiting.text}</TableCell>
                  <TableCell className="py-3 whitespace-nowrap">
                    {publish ? (
                      <>
                        <p className="text-neutral-950">{publish.day}</p>
                        <p className={cn("mt-1", publish.urgent ? "text-red-500" : "text-neutral-950/60")}>{publish.time}</p>
                      </>
                    ) : (
                      <span className="text-neutral-950/60">Not scheduled</span>
                    )}
                  </TableCell>
                  <TableCell className="py-3">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-1.5 py-0.5 type-body-sb-xxs whitespace-nowrap text-red-400">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-red-100" />
                      Pending review
                    </span>
                  </TableCell>
                  <TableCell className="py-3">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="border-neutral-600 px-3 text-neutral-600"
                      aria-label={`Review design: ${post.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onReview(post.id);
                      }}
                    >
                      Review design
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {posts.length === 0 && <p className="px-4 py-10 text-center type-body-r-s text-neutral-500">Nothing is waiting for your review.</p>}
      </div>

      <p aria-live="polite" className="type-body-r-xs text-neutral-500">
        {queueFooter(posts.length, pending, revision, approved)}
      </p>
    </DesignPanel>
  );
}
