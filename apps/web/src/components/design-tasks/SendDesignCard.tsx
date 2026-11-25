"use client";

import { useEffect, useState } from "react";
import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon, SendIcon, TriangleAlertIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/cn";
import { cleanLink, linkState, markTaskDone, saveTaskDraft, type TaskDetail } from "@/lib/design-tasks";
import { isFigmaDesignUrl } from "@/lib/figmaLink";
import { wibWhen } from "@/lib/post-editor";
import { useFigmaCheck } from "@/lib/useFigmaCheck";

const NOTE_MAX = 2000;
const LABEL = "type-body-sb-xs text-muted";

const LINE = {
  idle: "text-muted",
  checking: "text-muted",
  valid: "text-green-700",
  warn: "text-brand-800",
  error: "text-red-600",
} as const;

type Props = {
  task: TaskDetail;
  /** The task changed on the server (a draft saved, the design sent): ask for it again. */
  onChanged: () => void;
};

/**
 * "Send design to Marketing": the Figma link with its check, an optional note, Mark as done and Save draft. Mark as done
 * stays off until Figma can open the link; Save draft keeps the link on the designer's side only. Once the task is done
 * the card is the record of what was sent.
 */
export function SendDesignCard({ task, onChanged }: Props) {
  const toast = useToast();
  const done = task.status === "done";
  const [link, setLink] = useState(task.figmaUrl ?? "");
  const [note, setNote] = useState(task.designerNote ?? "");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // what the server holds is the truth: a reload after saving or sending puts the saved values back in the fields
  useEffect(() => {
    setLink(task.figmaUrl ?? "");
    setNote(task.designerNote ?? "");
  }, [task.figmaUrl, task.designerNote]);

  const figma = useFigmaCheck(link, !done);
  const state = linkState(link, figma.checking, figma.checked);
  const dirty = cleanLink(link) !== (task.figmaUrl ?? "") || note.trim() !== (task.designerNote ?? "");
  // a draft may hold a link Figma cannot open yet (the file is still private while the designer works), but never one that is not a Figma link
  const draftOk = cleanLink(link) === "" || isFigmaDesignUrl(link);
  const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

  async function saveDraft() {
    setBusy(true);
    try {
      await saveTaskDraft(task.postId, { figmaUrl: cleanLink(link), note: note.trim() });
      toast.success("Draft saved. Marketing can't see it yet.");
      onChanged();
    } catch (e) {
      toast.error(message(e, "The draft could not be saved. Try again."));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function markDone() {
    try {
      await markTaskDone(task.postId, { figmaUrl: cleanLink(link), note: note.trim() });
    } catch (e) {
      toast.error(message(e, "The design could not be sent. Try again."));
      figma.recheck(); // a "can't open" answer from the server is the new truth for this link
      throw e;
    }
    toast.success("Design sent to Marketing.");
    onChanged();
  }

  if (done) {
    return (
      <Card className="gap-4 border-0 p-5">
        <h2 className="type-body-sb-m text-fg">Design sent to Marketing</h2>
        <dl className="flex flex-col gap-3">
          <div>
            <dt className={LABEL}>Figma link</dt>
            <dd className="mt-1 min-w-0 truncate type-body-r-s">
              {task.figmaUrl ? (
                <a href={task.figmaUrl} target="_blank" rel="noopener noreferrer" className="text-brand-800 underline underline-offset-2">
                  {task.figmaUrl}
                </a>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt className={LABEL}>Note for Marketing</dt>
            <dd className="mt-1 type-body-r-s break-words whitespace-pre-wrap text-fg">{task.designerNote || "No note"}</dd>
          </div>
        </dl>
        <p className="flex items-center gap-1.5 type-body-r-xs text-green-700">
          <CircleCheckIcon aria-hidden="true" className="size-3.5" />
          {task.doneAt ? `Sent ${wibWhen(new Date(task.doneAt))}. ` : ""}The link is locked.
        </p>
      </Card>
    );
  }

  const Icon = state.tone === "checking" ? LoaderCircleIcon : state.tone === "valid" ? CircleCheckIcon : state.tone === "warn" ? TriangleAlertIcon : CircleAlertIcon;

  return (
    <Card className="gap-4 border-0 p-5">
      <h2 className="type-body-sb-m text-fg">Send design to Marketing</h2>
      {task.revisionNote && <div className="rounded-xl bg-brand-100 p-3 text-brand-800"><p className="type-body-sb-s">Design revision requested</p><p className="mt-1 type-body-r-s whitespace-pre-wrap">{task.revisionNote}</p></div>}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="figma-link" className={LABEL}>
          Figma link<span className="text-red-600" aria-hidden="true"> *</span>
        </label>
        <Input
          id="figma-link"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste your Figma link here"
          value={link}
          maxLength={500}
          disabled={busy}
          aria-invalid={state.tone === "error"}
          aria-describedby="figma-link-status"
          onChange={(e) => setLink(e.target.value)}
        />
        {/* always in the page, so a screen reader hears the answer when it arrives */}
        <div id="figma-link-status" role="status" aria-live="polite" className="min-h-5">
          {state.message && (
            <p className={cn("flex items-start gap-1.5 type-body-r-xs", LINE[state.tone])}>
              <Icon aria-hidden="true" className={cn("mt-0.5 size-3.5 shrink-0", state.tone === "checking" && "animate-spin")} />
              <span className="min-w-0 break-words">{state.message}</span>
              {(state.tone === "error" && figma.checked?.state === "private") || state.tone === "warn" ? (
                <Button type="button" variant="link" size="sm" className="ml-1 h-auto shrink-0 p-0" onClick={figma.recheck}>
                  Check again
                </Button>
              ) : null}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="designer-note" className={LABEL}>
          Note for Marketing (optional)
        </label>
        <Textarea id="designer-note" rows={4} maxLength={NOTE_MAX} placeholder="Add a note for Marketing…" value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
        <p className="type-body-r-xs text-muted">Optional · visible to Marketing</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || !state.canMarkDone} onClick={() => setConfirming(true)}>
          <SendIcon />
          Mark as done
        </Button>
        <Button variant="secondary" disabled={busy || !dirty || !draftOk} onClick={saveDraft}>
          Save draft
        </Button>
      </div>
      <p className="type-body-r-xs text-muted">
        {state.canMarkDone ? "Mark as done sends the link to Marketing and locks it." : "Mark as done turns on once Figma can open your link."} Save draft keeps it to yourself.
      </p>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="default"
        size="compact"
        icon={<SendIcon />}
        title="Send design to Marketing?"
        description="Marketing will receive your Figma link. You can’t change it after sending."
        confirmLabel="Send to Marketing"
        pendingLabel="Sending…"
        onConfirm={markDone}
      >
        <div className="mt-1 min-w-0">
          <p className="type-body-m-s break-words text-fg">{task.title}</p>
          <a href={cleanLink(link)} target="_blank" rel="noopener noreferrer" className="mt-1 block truncate type-body-r-xs text-brand-800 underline underline-offset-2">
            {figma.checked?.state === "valid" && figma.checked.title ? figma.checked.title : "Open Figma file"}
          </a>
        </div>
      </ConfirmDialog>
    </Card>
  );
}
