"use client";

import { useMemo, useRef } from "react";
import type { CanvasDocument, CanvasStageHandle } from "posthive-canvas";
import { Button } from "@/components/ui/button";
import { editorFonts } from "@/lib/canvas";
import type { CanvasEngine } from "./useCanvasBootstrap";

const ZOOM_STEP = 1.25;

/**
 * A design shown and nothing more: the engine's "readonly" mode (no selection, no handles, nothing editable), with zoom and
 * fit, because looking closely is the point of a review. The document is what the server composed; nothing here changes it.
 * The Konva engine comes in as a prop because it loads in the browser only. `images` are the decoded images the design draws
 * (a missing one is a grey box, as in the editor).
 */
export function ReadOnlyStage({ engine, doc, images }: { engine: CanvasEngine; doc: CanvasDocument; images: ReadonlyMap<string, HTMLImageElement> }) {
  const { CanvasStage } = engine;
  // A ref object, never state: CanvasStage makes a new handle on every render, and a state setter as its ref would re-render this
  // component on every commit, forever ("Maximum update depth exceeded"). The editors hold the handle the same way.
  const handle = useRef<CanvasStageHandle>(null);
  const fonts = useMemo(() => editorFonts(), []);
  return (
    <div className="relative size-full min-h-64 overflow-hidden rounded-xl border border-border bg-background">
      <CanvasStage
        ref={handle}
        mode="readonly"
        doc={doc}
        selectedId={null}
        images={images}
        fonts={fonts}
        onSelect={() => {}}
        onChange={() => {}}
        className="absolute inset-0 touch-none overflow-hidden outline-none data-[panning]:cursor-grab"
      />
      <div className="absolute right-2 bottom-2 flex gap-1">
        <Button size="sm" variant="secondary" aria-label="Zoom out" onClick={() => handle.current?.zoomBy(1 / ZOOM_STEP)}>
          −
        </Button>
        <Button size="sm" variant="secondary" aria-label="Fit to screen" onClick={() => handle.current?.fit()}>
          Fit
        </Button>
        <Button size="sm" variant="secondary" aria-label="Zoom in" onClick={() => handle.current?.zoomBy(ZOOM_STEP)}>
          +
        </Button>
      </div>
    </div>
  );
}
