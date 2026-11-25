"use client";

import { useMemo, useState } from "react";
import { ListChecksIcon, RefreshCwIcon } from "lucide-react";
import { DesignStat } from "@/components/dashboard/designer/DesignStat";
import { TaskTable } from "@/components/design-tasks/TaskTable";
import { EmptyState } from "@/components/EmptyState";
import { InlineAlert } from "@/components/InlineAlert";
import { Pager } from "@/components/Pager";
import { TemplatesHeader } from "@/components/templates/TemplatesHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { TASK_TABS, tasksFooter, tasksSubtitle, type TaskTab } from "@/lib/design-tasks";
import { useTaskList } from "@/lib/useDesignTasks";

const EMPTY: Record<TaskTab, string> = {
  all: "Nothing is assigned to you yet. When Marketing sends you a design request it appears here.",
  assigned: "No new tasks. Everything assigned to you is started or done.",
  progress: "Nothing in progress. Save a draft link on a task and it moves here.",
  done: "You haven't sent a design to Marketing yet.",
};

/** My Task (docs/design/designer/My Task · Designer (list).png): the design requests Marketing sent to this designer. */
export default function MyTasksPage() {
  const [tab, setTab] = useState<TaskTab>("all");
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useTaskList(tab, page);
  const now = useMemo(() => new Date(), []);
  const counts = data?.counts;

  const pick = (next: TaskTab) => {
    setTab(next);
    setPage(1);
  };
  const countOf = (t: TaskTab) => (!counts ? null : t === "all" ? counts.assigned + counts.progress + counts.done : counts[t]);

  return (
    // The shell clips its content, so the page scrolls inside this box
    <div className="theme-dashboard flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-[110rem] flex-col gap-4 p-4 pt-16 md:p-6 md:pt-6">
        <TemplatesHeader
          crumbs={[{ label: "Design workspace" }, { label: "My task" }]}
          title="My tasks"
          subtitle={counts ? tasksSubtitle(counts) : error ? "We couldn't load your tasks." : "Loading your tasks…"}
        />

        {error && (
          <InlineAlert tone="danger" title={data ? "Couldn't refresh your tasks" : "Couldn't load your tasks"}>
            {error}{" "}
            <Button variant="link" size="sm" className="inline-flex h-auto p-0" onClick={reload}>
              <RefreshCwIcon /> Try again
            </Button>
            {data && " Showing what was loaded before."}
          </InlineAlert>
        )}

        {!data && loading && (
          <div aria-busy="true" aria-label="Loading your tasks" className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Skeleton className="h-24 rounded-2xl" />
              <Skeleton className="h-24 rounded-2xl" />
              <Skeleton className="h-24 rounded-2xl" />
            </div>
            <Skeleton className="h-96 w-full rounded-2xl" />
          </div>
        )}

        {data && counts && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <DesignStat value={counts.assigned} label="Assigned to me" note="Not started yet" />
              <DesignStat value={counts.progress} label="In progress" note="A draft link is saved" tone="warn" />
              <DesignStat value={counts.waiting} label="Done · waiting for Marketing" note="Sent, not yet in review" tone="good" />
            </div>

            <Card className="gap-4 p-4 sm:p-5">
              <Tabs value={tab} onValueChange={(v) => pick(v as TaskTab)} className="min-w-0 max-w-full">
                <TabsList aria-label="Task status" className="max-w-full flex-wrap justify-start border-0 bg-transparent p-0">
                  {TASK_TABS.map(({ id, label }) => (
                    <TabsTrigger key={id} value={id} className="group-data-[variant=default]/tabs-list:px-4 group-data-[variant=default]/tabs-list:py-2 group-data-[variant=default]/tabs-list:data-[state=active]:bg-neutral-50 group-data-[variant=default]/tabs-list:data-[state=active]:text-fg">
                      {label}
                      <span className={cn("min-w-5 rounded-full px-1.5 text-center type-body-sb-xxs tabular-nums", id === "all" ? "bg-brand-500 text-neutral-950" : "bg-green-600/10 text-green-700")}>{countOf(id)}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>

              {data.total === 0 ? (
                <EmptyState size="compact" icon={<ListChecksIcon />} title="No tasks here" description={EMPTY[tab]} />
              ) : (
                <TaskTable tasks={data.items} now={now} label="Your design tasks" empty={EMPTY[tab]} />
              )}

              <div className={cn("flex flex-wrap items-center justify-between gap-3", loading && "opacity-60")} aria-live="polite">
                <p className="type-body-r-xs text-neutral-500">{tasksFooter(data.items.length, data.total, counts.waiting)}</p>
                <Pager page={data.page} pageCount={data.pageCount} onPage={setPage} />
              </div>
            </Card>

            <p className="type-body-r-xs text-neutral-500">Design team cannot approve content · Admin approves after Marketing submits.</p>
          </>
        )}
      </div>
    </div>
  );
}
