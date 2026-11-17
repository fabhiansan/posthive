"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasDocument, CanvasNode, CanvasStageHandle, ExportOptions, History, MoveTo, NodePatch } from "posthive-canvas";
import { useToast } from "@/components/Toast";
import { editorFonts, loadAsset, uploadCanvasAsset } from "@/lib/canvas";
import type { CanvasEngine } from "./useCanvasBootstrap";
import { CanvasShell } from "./CanvasShell";
import { ExportMenu } from "./ExportMenu";
import { Inspector } from "./Inspector";
import { LayersPanel } from "./LayersPanel";
import { Toolbar } from "./Toolbar";

const TITLE = "Untitled design";
const ZOOM_STEP = 1.25;

/** Keys that must keep working inside a text field, a menu or a dialog instead of editing the design. */
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest('[role="menu"],[role="dialog"],[role="listbox"],[role="tablist"]'));

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * The Canvas editor on a local, unsaved document (saving arrives with persistence). It owns the document
 * and its undo history, the selection, the decoded images, and the keyboard. The Konva engine comes in as
 * a prop because it loads in the browser only; everything runtime is taken from it, never imported.
 */
export function CanvasEditor({ engine }: { engine: CanvasEngine }) {
  const { CanvasStage, createDocument, createShape, createText, createImage, addNode, updateNode, removeNode, moveNode, nodeById } = engine;
  const { createHistory, commit, seal, undo, redo, canUndo, canRedo, ExportError } = engine;
  const toast = useToast();

  const [history, setHistory] = useState<History<CanvasDocument>>(() => createHistory(createDocument()));
  const [selection, setSelection] = useState<string | null>(null);
  const [images, setImages] = useState<ReadonlyMap<string, HTMLImageElement>>(() => new Map());
  const [zoom, setZoom] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [textSignal, setTextSignal] = useState(0);
  const stage = useRef<CanvasStageHandle>(null);
  const fonts = useMemo(() => editorFonts(), []);

  const doc = history.present;
  // Undo can remove the selected layer; then nothing is selected.
  const selected: CanvasNode | undefined = nodeById(doc, selection);
  const selectedId = selected?.id ?? null;

  /** Applies a change to the document as one undo step (or merges into the last one when `key` repeats). */
  const edit = useCallback(
    (change: (d: CanvasDocument) => CanvasDocument, key: string | null = null) => setHistory((h) => commit(h, change(h.present), key)),
    [commit],
  );
  const patch = useCallback((id: string, p: NodePatch, key: string | null = null) => edit((d) => updateNode(d, id, p), key), [edit, updateNode]);

  const add = (node: CanvasNode) => {
    if (doc.nodes.length >= engine.MAX_NODES) {
      toast.warning(`A design can have up to ${engine.MAX_NODES} layers.`);
      return;
    }
    edit((d) => addNode(d, node));
    setSelection(node.id);
  };

  const remove = useCallback(() => {
    if (!selectedId) return;
    edit((d) => removeNode(d, selectedId));
    setSelection(null);
  }, [edit, removeNode, selectedId]);

  const onImage = async (file: File) => {
    setUploading(true);
    try {
      const asset = await uploadCanvasAsset(file);
      const image = await loadAsset(asset.url);
      setImages((m) => new Map(m).set(asset.id, image));
      add(createImage(doc, { ...asset, name: file.name.replace(/\.[^.]+$/, "") }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The image could not be added.");
    } finally {
      setUploading(false);
    }
  };

  const onExport = async (options: ExportOptions) => {
    if (!stage.current) return;
    setExporting(true);
    try {
      const blob = await stage.current.exportImage(options);
      const slug = TITLE.toLowerCase().replace(/\s+/g, "-");
      download(blob, `${slug}${options.multiplier === 2 ? "@2x" : ""}.${options.format === "png" ? "png" : "jpg"}`);
    } catch (err) {
      toast.error(err instanceof ExportError ? err.message : "The image could not be exported.");
    } finally {
      setExporting(false);
    }
  };

  // Keyboard. Typing in a field, a menu or a dialog keeps its own keys.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
      } else if (mod && key === "y") {
        e.preventDefault();
        setHistory(redo);
      } else if (!mod && (e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        remove();
      } else if (!mod && e.key === "Escape") {
        setSelection(null);
      } else if (!mod && selected && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        // Holding a key repeats it; the run is one undo step, sealed when the key comes up.
        patch(selected.id, { x: selected.x + dx, y: selected.y + dy }, `nudge:${selected.id}`);
      }
    };
    const up = (e: KeyboardEvent) => e.key.startsWith("Arrow") && setHistory(seal);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [selected, selectedId, remove, patch, redo, undo, seal]);

  return (
    <CanvasShell
      title={TITLE}
      propertiesSignal={textSignal}
      toolbar={
        <Toolbar
          onAdd={(type) => add(type === "text" ? createText(doc) : createShape(doc, type))}
          onImage={onImage}
          uploading={uploading}
          onDeselect={() => setSelection(null)}
          canUndo={canUndo(history)}
          canRedo={canRedo(history)}
          onUndo={() => setHistory(undo)}
          onRedo={() => setHistory(redo)}
          zoom={zoom}
          onZoomIn={() => stage.current?.zoomBy(ZOOM_STEP)}
          onZoomOut={() => stage.current?.zoomBy(1 / ZOOM_STEP)}
          onFit={() => stage.current?.fit()}
        />
      }
      actions={<ExportMenu width={doc.width} height={doc.height} busy={exporting} onExport={onExport} />}
      layers={
        <LayersPanel
          nodes={doc.nodes}
          selectedId={selectedId}
          onSelect={setSelection}
          onToggleVisible={(id) => edit((d) => updateNode(d, id, { visible: !nodeById(d, id)?.visible }))}
          onMove={(id: string, to: MoveTo) => edit((d) => moveNode(d, id, to))}
          onRename={(id, name) => patch(id, { name })}
        />
      }
      properties={
        <Inspector
          doc={doc}
          selected={selected}
          onPatch={(p, key) => selected && patch(selected.id, p, key)}
          onBackground={(color) => edit((d) => ({ ...d, background: { color } }), "background")}
          onSeal={() => setHistory(seal)}
          onDelete={remove}
          focusTextSignal={textSignal}
          fonts={Object.keys(fonts)}
        />
      }
    >
      <CanvasStage
        ref={stage}
        doc={doc}
        selectedId={selectedId}
        images={images}
        fonts={fonts}
        onSelect={setSelection}
        onChange={(id, p) => patch(id, p)}
        onEditText={(id) => {
          setSelection(id);
          setTextSignal((n) => n + 1);
        }}
        onZoomChange={setZoom}
        className="absolute inset-0 touch-none overflow-hidden outline-none data-[panning]:cursor-grab"
      />
    </CanvasShell>
  );
}
