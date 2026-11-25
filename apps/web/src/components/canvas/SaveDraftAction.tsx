"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SaveIcon } from "lucide-react";
import { InlineAlert } from "@/components/InlineAlert";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";

/** Where a saved Canvas design draft is found again. */
export const DESIGNS_HREF = "/canvas";

/**
 * "Save as draft" in the Canvas editor: saves the design NOW, then leaves for the list of the person's designs. It is a
 * Canvas DESIGN draft: it makes no post and sends nothing for review (the Add Content "Save as Draft" is a different thing, a post).
 * The design is already saved as the person works (autosave); this only waits until the server has CONFIRMED everything and
 * then leaves. `flush()` resolves true only when nothing is unsaved, so the toast and the move happen only then. When it cannot
 * (a lost connection, a conflict, an ended session, an archived design) it says so, stays on the page, and keeps every change.
 */
export function SaveDraftAction({ flush, disabled = false }: { flush: () => Promise<boolean>; disabled?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  async function save() {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      if (await flush()) {
        toast.success("Design draft saved. Find it under My designs.");
        router.push(DESIGNS_HREF);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true); // never a success: a flush that throws saved nothing we can vouch for
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void save()}
        disabled={disabled || saving}
        title="Save design as draft (Canvas). It doesn't create a post or send it for review."
      >
        <SaveIcon /> <span className="max-sm:sr-only">{saving ? "Saving…" : "Save as draft"}</span>
        <span className="sr-only"> (Canvas design draft: no post is created and nothing is sent for review)</span>
      </Button>
      {failed && (
        <InlineAlert tone="danger" role="alert" className="fixed top-16 right-3 z-50 max-w-sm shadow-md" title="Your draft was not saved">
          Your changes are still here. Check the message in the top bar, then try again.
        </InlineAlert>
      )}
    </>
  );
}
