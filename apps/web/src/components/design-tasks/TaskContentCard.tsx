import { ExternalLinkIcon } from "lucide-react";
import { InfoTile } from "@/components/content-list/InfoTile";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { shortName } from "@/lib/dashboard-format";
import { dueParts, formatOf, postStatusLine, type TaskDetail, type TaskLink } from "@/lib/design-tasks";
import { wibWhen } from "@/lib/post-editor";

const CAPTION_LIMIT = 2200;

/** A link from the plan or the editor: the address with an Open button, or the plain text it holds (a note, "ask Rina"). */
function LinkRow({ label, value, open }: { label: string; value: TaskLink; open: string }) {
  const empty = !value.link && !value.text;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-bg px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="type-body-r-xxs text-muted-foreground">{label}</p>
        <p className="mt-0.5 type-body-m-m break-all text-fg">{value.link ?? (value.text || "—")}</p>
      </div>
      {value.link && (
        <Button asChild variant="secondary" size="sm" className="shrink-0">
          <a href={value.link} target="_blank" rel="noopener noreferrer">
            {open}
            <ExternalLinkIcon />
          </a>
        </Button>
      )}
      {empty && <span className="sr-only">Not provided</span>}
    </div>
  );
}

/**
 * What Marketing filled in about the post, and the brief they wrote for the design: the left of the task page. Read-only
 * for the design team (the design says so): questions about the content go to Marketing, not to Admin.
 */
export function TaskContentCard({ task }: { task: TaskDetail }) {
  const publish = task.scheduledFor ? wibWhen(new Date(task.scheduledFor)) : "No publishing date yet";
  const deadline = dueParts(task.deadline);
  return (
    <>
      <Card className="gap-4 border-0 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="type-body-sb-m text-fg">Content information</h2>
          <p className="type-body-r-xs text-muted">From Marketing · read-only for Design</p>
        </div>

        <dl className="grid gap-3">
          <InfoTile label="Content title">{task.title}</InfoTile>
          <div className="min-w-0 rounded-xl bg-bg px-4 py-3">
            <dt className="type-body-r-xxs text-muted-foreground">Content description / caption</dt>
            <dd className="mt-0.5 type-body-m-m break-words whitespace-pre-wrap text-fg">{task.caption || "No caption yet"}</dd>
            <p className="mt-2 type-body-r-xs text-muted">
              Caption · {task.captionLength.toLocaleString("en-US")} / {CAPTION_LIMIT.toLocaleString("en-US")} characters
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <InfoTile label="Content pillar">{task.pillar ?? "—"}</InfoTile>
            <InfoTile label="Content format">{formatOf(task)}</InfoTile>
          </div>
          <InfoTile label="Approval status">{postStatusLine(task.postStatus, task.approvalStatus)}</InfoTile>
          <InfoTile label="Publishing date and time">{publish}</InfoTile>
          <div className="min-w-0 rounded-xl bg-bg px-4 py-3">
            <dt className="type-body-r-xxs text-muted-foreground">Publishing platform / channel · from Marketing</dt>
            <dd className="mt-1">
              {task.accounts.length === 0 ? (
                <span className="type-body-m-m text-fg">No channel yet</span>
              ) : (
                <ul className="flex flex-wrap gap-x-5 gap-y-2">
                  {task.accounts.map((a) => (
                    <li key={`${a.platform}-${a.displayName}`} className="flex items-center gap-2 type-body-m-m text-fg">
                      <PlatformIcon platform={a.platform} size={18} />
                      {a.displayName}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>

        <LinkRow label="Copywriting link" value={task.copywriting} open="Open link" />
        <LinkRow label="Supporting assets" value={task.assets} open="Open link" />
      </Card>

      <Card className="gap-4 border-0 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="type-body-sb-m text-fg">Design brief · overall direction</h2>
          <p className="type-body-r-xs text-muted">
            {[formatOf(task), ...task.accounts.map((a) => a.displayName)].filter((x) => x !== "—").join(" · ")}
          </p>
        </div>
        <dl className="grid gap-3">
          <div className="min-w-0 rounded-xl bg-bg px-4 py-3">
            <dt className="type-body-r-xxs text-muted-foreground">Visual direction</dt>
            <dd className="mt-0.5 type-body-m-m break-words whitespace-pre-wrap text-fg">{task.briefFull}</dd>
            <p className="mt-2 type-body-r-xs text-muted">Read-only · written by Marketing</p>
          </div>
          {task.referenceUrl && <LinkRow label="Reference link" value={{ link: task.referenceUrl, text: "" }} open="Open reference" />}
          <div className="grid gap-3 sm:grid-cols-2">
            <InfoTile label="Assigned by">{task.assignedBy ? shortName(task.assignedBy) : "Marketing"}</InfoTile>
            <InfoTile label="Design deadline">{deadline ? `${deadline.day}, ${deadline.time}` : "No deadline"}</InfoTile>
          </div>
        </dl>
      </Card>
    </>
  );
}
