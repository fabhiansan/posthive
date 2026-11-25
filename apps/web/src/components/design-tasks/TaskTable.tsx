"use client";

import type { KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PlatformIcon } from "@/components/PlatformIcon";
import { cn } from "@/lib/cn";
import { dueIn, dueParts, formatOf, type TaskItem } from "@/lib/design-tasks";
import { Person, TaskStatusPill, TaskThumb } from "./TaskParts";

type Props = {
  tasks: TaskItem[];
  now: Date;
  /** Names the table for a screen reader. */
  label: string;
  /** What an empty table says. */
  empty: string;
};

const COLUMNS = ["Thumbnail", "Task", "Content format", "Assigned by", "Due in", "Due date", "Status", "Action"];

/**
 * The tasks of the design team as a table (the dashboard's "Tasks assigned to you" and My Task). A row is a button: Tab
 * reaches it, Enter opens the task. The date columns are the deadline Marketing set, or "No deadline".
 */
export function TaskTable({ tasks, now, label, empty }: Props) {
  const router = useRouter();
  const open = (id: string) => router.push(`/tasks/${encodeURIComponent(id)}`);
  // Keys count only when the row itself has focus, so Enter on the button inside is the button's
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(id);
    }
  };

  return (
    <div className="overflow-x-auto rounded-2xl border border-neutral-200">
      <Table aria-label={label} className="min-w-240 type-body-r-xs">
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
          {tasks.map((t) => {
            const due = dueIn(t.deadline, t.status, now);
            const when = dueParts(t.deadline);
            return (
              <TableRow
                key={t.postId}
                tabIndex={0}
                aria-label={`Open ${t.title}`}
                onClick={() => open(t.postId)}
                onKeyDown={(e) => onKey(e, t.postId)}
                className="cursor-pointer border-neutral-50 bg-surface outline-none hover:bg-brand-50 focus-visible:bg-brand-50 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
              >
                <TableCell className="w-14 py-3 pr-0">
                  <TaskThumb src={t.thumbnail} />
                </TableCell>
                <TableCell className="py-3">
                  <p className="max-w-60 min-w-40 truncate type-body-m-xs text-neutral-950" title={t.title}>
                    {t.title}
                  </p>
                  <div className="mt-1 flex items-center gap-1.5 text-neutral-950/60">
                    {t.channels.slice(0, 3).map((p) => (
                      <PlatformIcon key={p} platform={p} size={12} />
                    ))}
                    <span className="truncate">{t.pillar ?? "No pillar"}</span>
                  </div>
                </TableCell>
                <TableCell className="py-3 whitespace-nowrap text-neutral-950">{formatOf(t)}</TableCell>
                <TableCell className="py-3">
                  <Person name={t.assignedBy} />
                </TableCell>
                <TableCell className={cn("py-3 whitespace-nowrap", due.urgent ? "text-red-500" : "text-neutral-950")}>{due.text}</TableCell>
                <TableCell className="py-3 whitespace-nowrap">
                  {when ? (
                    <>
                      <p className="text-neutral-950">{when.day}</p>
                      <p className={cn("mt-1", due.urgent ? "text-red-500" : "text-neutral-950/60")}>{when.time}</p>
                    </>
                  ) : (
                    <span className="text-neutral-950/60">No deadline</span>
                  )}
                </TableCell>
                <TableCell className="py-3">
                  <TaskStatusPill status={t.status} />
                </TableCell>
                <TableCell className="py-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="border-neutral-600 px-3 text-neutral-600"
                    aria-label={`Open task: ${t.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      open(t.postId);
                    }}
                  >
                    Open task
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {tasks.length === 0 && <p className="px-4 py-10 text-center type-body-r-s text-neutral-500">{empty}</p>}
    </div>
  );
}
