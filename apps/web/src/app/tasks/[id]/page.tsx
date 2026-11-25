"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FileTextIcon, RefreshCwIcon } from "lucide-react";
import { SendDesignCard } from "@/components/design-tasks/SendDesignCard";
import { TaskContentCard } from "@/components/design-tasks/TaskContentCard";
import { EmptyState } from "@/components/EmptyState";
import { InlineAlert } from "@/components/InlineAlert";
import { TemplatesHeader } from "@/components/templates/TemplatesHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { dueParts, historyLine, taskBanner, whoAssigned } from "@/lib/design-tasks";
import { wibWhen } from "@/lib/post-editor";
import { useTask } from "@/lib/useDesignTasks";

/** A task of the design team (docs/design/designer/My Task · Designer · Task Detail): the brief on the left, the answer on the right. */
export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: task, loading, error, status, reload } = useTask(id);
  const deadline = task ? dueParts(task.deadline) : null;
  const banner = task ? taskBanner(task) : null;

  return (
    // The shell clips its content, so the page scrolls inside this box
    <div className="theme-dashboard flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-[110rem] flex-col gap-4 p-4 pt-16 md:p-6 md:pt-6">
        <TemplatesHeader
          crumbs={[{ label: "Design workspace", href: "/tasks" }, { label: "Task detail" }]}
          title="Design task"
          subtitle={task ? `Assigned by ${whoAssigned(task)} · ${deadline ? `Due ${deadline.day}, ${deadline.time}` : "No deadline"}` : undefined}
        />

        {!task && loading && <Skeleton aria-busy="true" aria-label="Loading the task" className="h-96 rounded-2xl" />}

        {!task && !loading && status === 404 && (
          <Card className="border-0">
            <EmptyState
              icon={<FileTextIcon />}
              title="Task not found"
              description="It was not sent to you, or Marketing took the request back."
              action={<Button asChild variant="secondary" className="w-fit"><Link href="/tasks">Back to My task</Link></Button>}
            />
          </Card>
        )}

        {!task && !loading && status !== 404 && error && (
          <InlineAlert tone="danger" title="Couldn't load the task">
            {error}{" "}
            <Button variant="link" size="sm" className="inline-flex h-auto p-0" onClick={reload}>
              <RefreshCwIcon /> Try again
            </Button>
          </InlineAlert>
        )}

        {task && banner && (
          <>
            {error && (
              <InlineAlert tone="danger" title="Couldn't refresh the task">
                {error} Showing what was loaded before.
              </InlineAlert>
            )}
            <InlineAlert tone={banner.tone} role="status" title={banner.title} className="border-0">
              {banner.body}
            </InlineAlert>

            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div className="flex min-w-0 flex-col gap-4">
                <TaskContentCard task={task} />
              </div>
              <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4">
                <SendDesignCard task={task} onChanged={reload} />
                <Card className="gap-3 border-0 p-5">
                  <h2 className="type-body-sb-m text-fg">History</h2>
                  <ol aria-label="History of the task" className="flex flex-col gap-3">
                    {task.history.map((e) => (
                      <li key={e.kind} className="min-w-0">
                        <p className="type-body-m-s text-fg">{historyLine(e.kind, task.assignedBy)}</p>
                        <p className="type-body-r-xs text-muted">{wibWhen(new Date(e.at))}</p>
                      </li>
                    ))}
                  </ol>
                </Card>
              </div>
            </div>

            <Card className="border-0 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="type-body-r-xs text-muted">Design team cannot approve content · Admin approves after Marketing submits</p>
                <Button asChild variant="secondary">
                  <Link href="/tasks">Back to My task</Link>
                </Button>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
