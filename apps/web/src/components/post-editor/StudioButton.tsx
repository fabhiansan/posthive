"use client";

import { useEffect, useState } from "react";
import { ExternalLinkIcon, PaletteIcon } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { createInstance, getInstance } from "@/lib/canvas";
import { hasCanvasSource, hasFigmaSource, isFigmaLink, type DesignTemplate } from "@/lib/templates";

type Props = {
  template: DesignTemplate;
  /** The Canvas design this post already opened from this template, if any. */
  canvasInstanceId: string | null;
  canvasTemplateId: string | null;
  /** The post's id, creating the draft first in Add mode: Studio opens a design that belongs to a post that exists. */
  ensurePost: () => Promise<string>;
  /** Saves the design on the post. Never an edit of the content: it does not send the post back out of review. */
  onOpened: (ids: { canvasInstanceId: string; canvasTemplateId: string }, postId: string) => Promise<void>;
  /** Told while the design is being made and saved on the post, so the page does not save the same post at the same time. */
  onBusy?: (busy: boolean) => void;
  disabled?: boolean;
};

/**
 * "Open Studio Editor": opens the template in Canvas in a NEW tab, so what is typed here is not lost. The design is saved
 * on the post: pressing it again opens the same design, not another one. A template that has no Canvas design but a Figma
 * link opens that link; one with neither says so.
 */
export function StudioButton({ template, canvasInstanceId, canvasTemplateId, ensurePost, onOpened, onBusy, disabled }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // The design the post kept: used only when it was made from THIS template (a category change never reopens another's)
  const kept = canvasTemplateId === template.id ? canvasInstanceId : null;
  // undefined = not asked yet; null = it is not there any more (archived, or somebody else's)
  const [alive, setAlive] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!kept) return setAlive(null);
    let live = true;
    setAlive(undefined);
    getInstance(kept).then(() => live && setAlive(kept)).catch(() => live && setAlive(null));
    return () => {
      live = false;
    };
  }, [kept]);

  if (!hasCanvasSource(template.canvasRevision)) {
    if (hasFigmaSource(template.linkUrl) && template.linkUrl) {
      return (
        <Button asChild variant="secondary">
          <a href={template.linkUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon />
            {isFigmaLink(template.linkUrl) ? "Open in Figma" : "Open link"}
          </a>
        </Button>
      );
    }
    return <p className="type-body-r-xs text-muted">This template has no design file yet. The design team adds one in Templates.</p>;
  }

  if (alive) {
    return (
      <Button asChild>
        <a href={`/canvas/${alive}`} target="_blank" rel="noopener noreferrer">
          <PaletteIcon />
          Open Studio Editor
        </a>
      </Button>
    );
  }

  async function start() {
    // Opened now, before anything is awaited: a browser lets a click open a tab, and blocks one opened after a wait
    const tab = window.open("", "_blank");
    setBusy(true);
    onBusy?.(true);
    try {
      const postId = await ensurePost();
      const { instance } = await createInstance(template.id);
      await onOpened({ canvasInstanceId: instance.id, canvasTemplateId: template.id }, postId);
      if (tab) tab.location.href = `${window.location.origin}/canvas/${instance.id}`;
      else toast.success("Your design is ready. Press Open Studio Editor.");
    } catch (e) {
      tab?.close();
      toast.error(e instanceof Error && e.message ? e.message : "The design could not be created. Try again.");
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  }

  return (
    <Button disabled={disabled || busy || alive === undefined} aria-busy={busy} onClick={() => void start()}>
      {busy ? <Spinner size="sm" label="Creating" /> : <PaletteIcon />}
      Open Studio Editor
    </Button>
  );
}
