"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { PostEditor } from "./usePostEditor";

/** The bar under the form: what is unsaved or why a button is off on the left, Cancel, Save as Draft and the main action on the right. */
export function ActionBar({ editor }: { editor: PostEditor }) {
  const router = useRouter();
  const [discarding, setDiscarding] = useState(false);
  const { actions, busy, dirty, uploading, opening, primaryBlock, saveBlocked, readOnlyReason } = editor;
  const working = busy !== null || uploading || opening;
  const primary = actions.primary;

  // one line on the left: the reason a button is off (it is text, not a tooltip: a disabled button takes no focus and a tooltip
  // does not show on touch), else whether there is something unsaved
  const note = readOnlyReason ?? (primary && primaryBlock) ?? (uploading ? "Uploading…" : opening ? "Opening the Studio…" : dirty ? "Unsaved changes" : "All changes saved");
  const reason = Boolean(readOnlyReason || (primary && primaryBlock));

  const leave = () => (dirty ? setDiscarding(true) : router.push("/jobs"));
  const saveOnly = primary?.kind === "save";

  return (
    <Card className="z-10 flex-row flex-wrap items-center gap-x-4 gap-y-3 border-0 px-5 py-4 shadow-sm lg:sticky lg:bottom-0">
      <p id="action-reason" role="status" className={reason ? "min-w-0 flex-1 basis-60 type-body-r-xs text-brand-800" : "min-w-0 flex-1 basis-60 type-body-r-xs text-muted"}>{note}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={leave}>Cancel</Button>
        {!readOnlyReason && (
          <>
            {actions.secondary && (
              <Button variant="secondary" disabled={working || saveBlocked !== null} onClick={() => void editor.saveDraft()}>
                {busy === "draft" ? "Saving…" : actions.secondary}
              </Button>
            )}
            {primary && (
              <Button
                disabled={working || primaryBlock !== null || (saveOnly && !dirty)}
                aria-describedby={primaryBlock ? "action-reason" : undefined}
                onClick={() => void (primary.kind === "submit" ? editor.submit() : primary.kind === "schedule" ? editor.schedule() : editor.savePrimary())}
              >
                {busy === "primary" ? "Working…" : primary.label}
              </Button>
            )}
          </>
        )}
      </div>
      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        tone="danger"
        title="Discard your changes?"
        description="What you changed on this page is not saved. If you leave now it is lost."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onConfirm={() => router.push("/jobs")}
      />
    </Card>
  );
}
