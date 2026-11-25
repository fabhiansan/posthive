"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";

export function DesignRevisionButton({ postId, onChanged }: { postId: string | (() => Promise<string>); onChanged: (result: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  return <>
    <Button variant="secondary" onClick={() => { setError(""); setOpen(true); }}>Request design revision</Button>
    <ConfirmDialog open={open} onOpenChange={setOpen} tone="default" size="compact" title="Request design revision?" description="Tell the designer what to change. Submit to Admin stays off until the revised design is sent back." confirmLabel="Send revision request" pendingLabel="Sending…" confirmDisabled={!note.trim()} onConfirm={async () => {
      try {
        const id = typeof postId === "function" ? await postId() : postId;
        const result = await apiFetch(`/jobs/${encodeURIComponent(id)}/design-request/revision`, { method: "POST", body: JSON.stringify({ note: note.trim() }) });
        setNote("");
        onChanged(result);
      } catch (e) { setError(e instanceof Error ? e.message : "Could not request the revision."); throw e; }
    }}>
      <label htmlFor="revision-note" className="mt-3 type-body-sb-xs">Design changes needed</label>
      <Textarea id="revision-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={4} />
      {error && <p role="alert" className="type-body-r-s text-red-600">{error}</p>}
    </ConfirmDialog>
  </>;
}
