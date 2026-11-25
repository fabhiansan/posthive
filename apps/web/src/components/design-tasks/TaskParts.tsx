"use client";

import { useState } from "react";
import { ImageIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { assetUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { initialsOf, shortName } from "@/lib/dashboard-format";
import { TASK_STATUS_LABEL, type TaskStatus } from "@/lib/design-tasks";

// The small pieces a task is drawn with, on the dashboard and on My Task: the status pill, the picture, the person.

const PILL: Record<TaskStatus, { box: string; dot: string }> = {
  assigned: { box: "bg-neutral-50 text-neutral-800", dot: "bg-neutral-500" },
  progress: { box: "bg-blue-600/10 text-blue-700", dot: "bg-blue-600" },
  done: { box: "bg-green-600/10 text-green-700", dot: "bg-green-600" },
};

/** Assigned, In progress or Done, as the pill the design draws: a tint of the colour with a dot. */
export function TaskStatusPill({ status, className }: { status: TaskStatus; className?: string }) {
  const tone = PILL[status];
  return (
    <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 type-body-sb-xxs whitespace-nowrap", tone.box, className)}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone.dot)} />
      {TASK_STATUS_LABEL[status]}
    </span>
  );
}

/** The post's first picture. One that cannot be shown (a deleted file) is a quiet olive tile with an icon, not a broken image. */
export function TaskThumb({ src, className }: { src: string | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={cn("flex h-14 w-11 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-neutral-700", className)}>
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={assetUrl(src)} alt="" loading="lazy" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <ImageIcon aria-hidden="true" className="size-4 text-neutral-300" />
      )}
    </div>
  );
}

/** A small avatar with the name next to it: who assigned the task. */
export function Person({ name }: { name: string | null }) {
  return (
    <div className="flex items-center gap-2">
      <Avatar className="size-6">
        <AvatarFallback className="bg-brand-500 text-neutral-950">{initialsOf(name)}</AvatarFallback>
      </Avatar>
      <span className="whitespace-nowrap text-neutral-950">{shortName(name) || "—"}</span>
    </div>
  );
}
