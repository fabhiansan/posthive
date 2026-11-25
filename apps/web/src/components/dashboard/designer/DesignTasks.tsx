"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TaskTable } from "@/components/design-tasks/TaskTable";
import { tasksFooter, type TaskCounts, type TaskItem } from "@/lib/design-tasks";
import { DesignPanel } from "./DesignPanel";

type Props = {
  /** The open tasks, soonest deadline first (a few: "View all" has the rest). */
  tasks: TaskItem[];
  counts: TaskCounts;
  now: Date;
};

/** "Tasks assigned to you": the posts Marketing asked this designer to design, soonest deadline first. A row opens the task. */
export function DesignTasks({ tasks, counts, now }: Props) {
  const open = counts.assigned + counts.progress;
  return (
    <DesignPanel
      title="Tasks assigned to you"
      action={
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="type-body-r-xs text-neutral-500">Needs your action · due soonest first</span>
          <Button asChild variant="secondary" size="sm" className="rounded-full border-neutral-500 px-3 text-neutral-400">
            <Link href="/tasks">View all</Link>
          </Button>
        </div>
      }
    >
      <TaskTable tasks={tasks} now={now} label="Tasks assigned to you" empty="Nothing is waiting for your design." />
      <p aria-live="polite" className="type-body-r-xs text-neutral-500">
        {tasksFooter(tasks.length, Math.max(open, tasks.length), counts.waiting)}
      </p>
    </DesignPanel>
  );
}
