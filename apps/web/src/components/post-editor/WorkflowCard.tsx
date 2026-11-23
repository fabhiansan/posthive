import { CheckIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { workflowSteps } from "@/lib/post-editor";

type Props = {
  post: { status: string; approvalStatus: string | null } | null;
  /** The workspace sends posts for review (otherwise there is no review step). */
  approvalFlow: boolean;
};

/** The Review workflow card: the steps a post goes through, in the app's own statuses, with the one it is at. */
export function WorkflowCard({ post, approvalFlow }: Props) {
  const steps = workflowSteps(post ?? { status: "draft", approvalStatus: null }, approvalFlow);
  const current = steps.find((s) => s.state === "current");
  return (
    <Card className="gap-4 border-0 p-5" role="region" aria-labelledby="workflow-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="workflow-heading" className="type-body-sb-m text-fg">Review workflow</h2>
        <p className="type-body-r-xs text-muted">Current: {current?.label ?? "Draft"}</p>
      </div>
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => (
          <li key={s.filter} aria-current={s.state === "current" ? "step" : undefined} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border type-body-sb-xxs",
                s.state === "current" ? "border-brand-600 bg-brand-500 text-accent-fg" : s.state === "done" ? "border-brand-600 bg-brand-100 text-brand-800" : "border-neutral-300 text-neutral-500",
              )}
            >
              {s.state === "done" ? <CheckIcon className="size-3.5" /> : i + 1}
            </span>
            <span className="min-w-0">
              <span className={cn("block type-body-sb-s", s.state === "todo" ? "text-muted" : "text-fg")}>
                {s.label}
                {s.state === "current" && <span className="sr-only"> (you are here)</span>}
              </span>
              <span className="block type-body-r-xs text-muted">{s.state === "current" ? `${s.note} · you are here` : s.note}</span>
            </span>
          </li>
        ))}
      </ol>
      {approvalFlow && (
        <p className="type-body-r-xs text-muted">
          Submit for Review moves this post to In Review. A change to its content there brings it back to Draft. A Revision Required answer unlocks it again.
        </p>
      )}
    </Card>
  );
}
