"use client";

import { useEffect, useMemo, useState } from "react";
import { LockIcon, Undo2Icon } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DatePicker } from "@/components/DatePicker";
import { InlineAlert } from "@/components/InlineAlert";
import { TimeInput24 } from "@/components/TimeInput24";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { wibDateKey } from "@/lib/datetime";
import { cancelDesignRequest, listDesigners, saveDesignRequest, type Designer } from "@/lib/jobActions";
import type { DesignRequestView } from "@/lib/jobTypes";
import { DEADLINE_TEXT, deadlineParts, deadlineProblem, requestLine, scheduledOf, wibWhen } from "@/lib/post-editor";

type Props = {
  request: DesignRequestView | null;
  /** The moment the post goes out, from the form (ISO), or null while it has no date. The server checks the saved one. */
  publishAt: string | null;
  /** The post's id, creating the draft first in Add mode. */
  ensurePost: () => Promise<string>;
  onChange: (request: DesignRequestView | null) => void;
  /** Reports an unsaved brief, so leaving the page asks first. */
  onDirtyChange: (dirty: boolean) => void;
  /** The post cannot take a request now (in review, scheduled). */
  disabled?: boolean;
};

const LABEL = "type-body-sb-xs text-muted";
const Req = () => <span className="text-red-600" aria-hidden="true"> *</span>;

/** Path B: ask a designer for the design. A saved brief can still change; a sent request is locked until Marketing cancels it. */
export function DesignRequestForm({ request, publishAt, ensurePost, onChange, onDirtyChange, disabled }: Props) {
  const toast = useToast();
  const sent = request?.status === "sent";

  const [designers, setDesigners] = useState<Designer[] | null>(null);
  const [designersFailed, setDesignersFailed] = useState(false);
  const [assigneeId, setAssigneeId] = useState(request?.assignee?.id ?? "");
  // The deadline is optional: a WIB date and a time, both empty when there is none. The time shows once a date is picked.
  const [deadlineDate, setDeadlineDate] = useState(() => deadlineParts(request?.deadline).date);
  const [deadlineTime, setDeadlineTime] = useState(() => deadlineParts(request?.deadline).time);
  const [brief, setBrief] = useState(request?.brief ?? "");
  const [referenceUrl, setReferenceUrl] = useState(request?.referenceUrl ?? "");
  const [busy, setBusy] = useState<"save" | "send" | "cancel" | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // The form follows the request when the request itself changed (saved, sent, cancelled): what the server has is what the
  // form shows. A save of the post reloads the same request as a new object; that must not put the old brief back over
  // what the person typed, so the effect keys on what the request IS, not on the object.
  const saved = request ? `${request.id}|${request.status}|${request.updatedAt}` : "";
  useEffect(() => {
    setAssigneeId(request?.assignee?.id ?? "");
    const when = deadlineParts(request?.deadline);
    setDeadlineDate(when.date);
    setDeadlineTime(when.time);
    setBrief(request?.brief ?? "");
    setReferenceUrl(request?.referenceUrl ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the fields are read from the request that `saved` names
  }, [saved]);

  useEffect(() => {
    if (sent) return;
    let live = true;
    listDesigners().then((d) => live && setDesigners(d)).catch(() => live && setDesignersFailed(true));
    return () => {
      live = false;
    };
  }, [sent]);

  const due = deadlineDate ? scheduledOf({ date: deadlineDate, time: deadlineTime }) : null;
  const dueIso = due ? due.toISOString() : null;
  const dirty = !sent && (assigneeId !== (request?.assignee?.id ?? "") || dueIso !== (request?.deadline ?? null) || brief !== (request?.brief ?? "") || referenceUrl !== (request?.referenceUrl ?? ""));
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const publish = publishAt ? new Date(publishAt) : null;
  const problem = due ? deadlineProblem(due, new Date(), publish) : null;
  // a designer and a brief are all it takes: the deadline is optional
  const complete = assigneeId !== "" && brief.trim() !== "";
  const left = useMemo(() => (request?.assignee && !request.assignee.active ? request.assignee : null), [request]);

  async function save(send: boolean) {
    setBusy(send ? "send" : "save");
    try {
      const id = await ensurePost();
      const saved = await saveDesignRequest(id, { assigneeId, deadline: dueIso, brief: brief.trim(), referenceUrl: referenceUrl.trim(), send });
      onChange(saved);
      toast.success(send ? "Design request sent." : "Brief saved.");
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "The request could not be saved. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!request) return;
    try {
      const id = await ensurePost();
      onChange(await cancelDesignRequest(id));
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "The request could not be cancelled. Try again.");
      throw e;
    }
    toast.danger("Design request cancelled. You can change it and send it again.");
  }

  if (sent && request) {
    return (
      <div className="flex flex-col gap-3 rounded-xl bg-brand-100/50 p-4">
        <h3 className="flex items-center gap-2 type-body-sb-m text-fg">
          <LockIcon aria-hidden="true" className="size-4" />
          Path B · Design request sent
        </h3>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
          <dt className={LABEL}>Designer</dt>
          <dd className="type-body-r-s text-fg">{requestLine(request)}</dd>
          <dt className={LABEL}>Brief</dt>
          <dd className="type-body-r-s whitespace-pre-wrap break-words text-fg">{request.brief}</dd>
          {request.referenceUrl && (
            <>
              <dt className={LABEL}>Reference</dt>
              <dd className="min-w-0 truncate type-body-r-s">
                <a href={request.referenceUrl} target="_blank" rel="noopener noreferrer" className="text-brand-800 underline underline-offset-2">{request.referenceUrl}</a>
              </dd>
            </>
          )}
        </dl>
        {left && <InlineAlert tone="warning" className="border-0">{left.name} is no longer in the design team. Cancel the request and send it to someone else.</InlineAlert>}
        {request.deadline && publish && publish.getTime() <= new Date(request.deadline).getTime() && (
          <InlineAlert tone="warning" className="border-0">The publishing time is now before the design deadline. Move one of them.</InlineAlert>
        )}
        <p className="type-body-r-xs text-muted">This request is locked. Submit for Review is off until the design comes back or you cancel the request.</p>
        <div>
          <Button variant="destructive-outline" disabled={busy !== null || disabled} onClick={() => setCancelling(true)}>
            <Undo2Icon />
            Cancel request
          </Button>
        </div>
        <ConfirmDialog
          open={cancelling}
          onOpenChange={setCancelling}
          tone="danger"
          icon={<Undo2Icon />}
          title="Cancel the design request?"
          description={`${requestLine(request)} will no longer have this request. Your brief stays, so you can change it and send it again.`}
          confirmLabel="Cancel request"
          pendingLabel="Cancelling…"
          cancelLabel="Keep request"
          onConfirm={cancel}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl bg-brand-100/50 p-4">
      <div>
        <h3 className="type-body-sb-m text-fg">Path B · Design request</h3>
        <p className="type-body-r-xs text-muted">No template for this content yet. Assign it to a designer with a brief; they send the Figma link back when it is done.</p>
      </div>

      {designersFailed && <InlineAlert tone="danger" className="border-0">We couldn&apos;t load the designers. Reload the page to try again.</InlineAlert>}
      {designers?.length === 0 && (
        <InlineAlert tone="warning" title="No designer in this workspace yet" className="border-0">
          Ask an admin to invite one in Team, then come back to send this request.
        </InlineAlert>
      )}

      <fieldset disabled={disabled || busy !== null} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL}>Designer (PIC)<Req /></span>
            <NativeSelect value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} containerClassName="mt-1.5" aria-required="true">
              <NativeSelectOption value="">{designers === null && !designersFailed ? "Loading designers…" : "Choose a designer"}</NativeSelectOption>
              {request?.assignee && !designers?.some((d) => d.id === request.assignee!.id) && (
                <NativeSelectOption value={request.assignee.id} disabled>{request.assignee.name} (no longer in the design team)</NativeSelectOption>
              )}
              {designers?.map((d) => <NativeSelectOption key={d.id} value={d.id}>{d.name}</NativeSelectOption>)}
            </NativeSelect>
          </label>
          <div>
            <span className={LABEL}>Design deadline (optional)</span>
            <div className="mt-1.5 flex flex-col gap-2">
              <DatePicker
                value={deadlineDate}
                onChange={(date) => {
                  setDeadlineDate(date);
                  // a picked day starts at 09:00 (what the time shows); a cleared one has no time either
                  setDeadlineTime(date ? deadlineTime || "09:00" : "");
                }}
                min={wibDateKey(new Date())}
                placeholder="Pick a deadline"
              />
              {deadlineDate && <TimeInput24 value={deadlineTime || "09:00"} onChange={setDeadlineTime} label="Deadline" />}
            </div>
            {problem ? (
              <p role="alert" className="mt-1.5 type-body-r-xs text-red-600">{DEADLINE_TEXT[problem]}</p>
            ) : (
              <p className="mt-1.5 type-body-r-xs text-muted">Optional. It must be before the post goes out{publish ? `: ${wibWhen(publish)}` : ""}.</p>
            )}
          </div>
        </div>

        <label className="block">
          <span className={LABEL}>Brief for designer<Req /></span>
          <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={5} maxLength={5000} className="mt-1.5 resize-y" aria-required="true" placeholder="What to design: slides, tone, palette, what the copy says." />
        </label>

        <label className="block">
          <span className={LABEL}>Reference link (optional)</span>
          <Input type="url" value={referenceUrl} onChange={(e) => setReferenceUrl(e.target.value)} placeholder="https://www.notion.so/…" className="mt-1.5" />
        </label>
      </fieldset>

      <p className="rounded-xl bg-surface px-3.5 py-2.5 type-body-r-xs text-muted">
        After sending, this request is locked and the designer sees it in their tasks (coming next). Changes come back to Marketing first.
      </p>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={disabled || busy !== null || !complete || problem !== null} onClick={() => void save(false)}>
          {busy === "save" ? "Saving…" : "Save brief"}
        </Button>
        <Button disabled={disabled || busy !== null || !complete || problem !== null || designers?.length === 0} onClick={() => void save(true)}>
          {busy === "send" ? "Sending…" : "Send Design Request"}
        </Button>
      </div>
    </div>
  );
}
