"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasDocument, CanvasNode, CanvasStageHandle, ExportOptions, History, MoveTo, NodePatch } from "posthive-canvas";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import type { Saved } from "@/lib/autosave";
import { STORAGE_UNSUPPORTED_MESSAGE, canvasProblem, editorFonts, getDesign, loadAsset, saveDesign, uploadCanvasAsset } from "@/lib/canvas";
import type { CanvasEngine, LoadedDesign } from "./useCanvasBootstrap";
import { CanvasShell } from "./CanvasShell";
import { ExportMenu } from "./ExportMenu";
import { Inspector } from "./Inspector";
import { LayersPanel } from "./LayersPanel";
import { PublishAction } from "./PublishAction";
import { ReviewIndicator } from "./ReviewIndicator";
import { needsBanner, SaveBanner, SaveStatus } from "./SaveStatus";
import { Toolbar } from "./Toolbar";
import { useAutosave } from "./useAutosave";

const TITLE = "Untitled design";
const ZOOM_STEP = 1.25;

/** Keys that must keep working inside a text field, a menu or a dialog instead of editing the design. */
export const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest('[role="menu"],[role="dialog"],[role="alertdialog"],[role="listbox"],[role="tablist"]'));

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file name from a design name: letters and digits, words joined by dashes. */
export const slugOf = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "design";

/**
 * The Canvas editor. With a saved `design` (a designer's, opened at /canvas/<id>) it autosaves; without one it is a local, unsaved
 * design. Nothing in the app opens it that way any more (Marketing has its own editor, InstanceEditor, and the page always passes a
 * design); the no-design branches are kept for now and can be removed. It owns the document and its undo history,
 * the selection, the decoded images, and the keyboard. The Konva engine comes in as a prop because it loads in the
 * browser only; everything runtime is taken from it, never imported. Mount it once per design (key it by id).
 */
export function CanvasEditor({ engine, design }: { engine: CanvasEngine; design?: LoadedDesign }) {
  const { CanvasStage, createDocument, createShape, createText, createImage, addNode, updateNode, removeNode, moveNode, nodeById, canAdd, cleanName, textRoom, editableLayers, LIMITS } = engine;
  const { createHistory, commit, seal, undo, redo, canUndo, canRedo, ExportError } = engine;
  const toast = useToast();

  const [history, setHistory] = useState<History<CanvasDocument>>(() => createHistory(design?.document ?? createDocument()));
  const [name, setName] = useState(design?.name ?? TITLE);
  const [selection, setSelection] = useState<string | null>(null);
  const [images, setImages] = useState<ReadonlyMap<string, HTMLImageElement>>(() => design?.images ?? new Map());
  const [zoom, setZoom] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [textSignal, setTextSignal] = useState(0);
  const [leaving, setLeaving] = useState<((leave: boolean) => void) | null>(null);
  const stage = useRef<CanvasStageHandle>(null);
  const fonts = useMemo(() => editorFonts(), []);

  const doc = history.present;
  // Undo can remove the selected layer; then nothing is selected.
  const selected: CanvasNode | undefined = nodeById(doc, selection);
  const selectedId = selected?.id ?? null;

  // ── Saving (a saved design only) ──────────────────────────────────────────
  /** Reload latest after a conflict: the server's version replaces everything here, history included. */
  const onReload = useCallback(
    (next: Saved<CanvasDocument>) => {
      setHistory(createHistory(next.doc));
      setName(next.name);
      setSelection(null);
    },
    [createHistory],
  );
  // Stable: the autosave makes its controller when this changes, so it is memoized on the loaded design (never rebuilt per render).
  const savedItem = useMemo(() => (design ? { id: design.id, version: design.version, name: design.name, value: design.document } : undefined), [design]);
  const autosave = useAutosave<CanvasDocument>({
    item: savedItem,
    value: doc,
    name,
    save: (id, version, snapshot) => saveDesign(id, { version, document: snapshot.doc, name: snapshot.name }),
    fetchLatest: async (id) => {
      const { design: latest } = await getDesign(id);
      return { version: latest.version, doc: latest.document, name: latest.name };
    },
    onReload,
  });
  // The latest published revision, which a Publish in this editor replaces. Reload latest does not change it: revisions only grow.
  const [revision, setRevision] = useState(design?.latestRevision ?? null);

  /** "Back to the dashboard": save first; if that cannot be done, ask before throwing the changes away. */
  const beforeLeave = async () => {
    if (await autosave.flush()) return true;
    return new Promise<boolean>((resolve) => setLeaving(() => resolve));
  };

  const rename = (raw: string) => {
    const next = cleanName(raw, LIMITS.designName.max);
    if (next) setName(next); // a blank name is refused: the field shows the old one again
  };

  // What the editor could not show when it opened.
  useEffect(() => {
    if (design?.badApiBase) toast.error("Images can't be loaded because the API address is not configured.");
    else if (design?.noStorage) toast.warning(STORAGE_UNSUPPORTED_MESSAGE);
    else if (design && design.missing.length > 0) {
      toast.warning(`${design.missing.length === 1 ? "An image" : `${design.missing.length} images`} in this design could not be found and ${design.missing.length === 1 ? "is" : "are"} shown as grey boxes.`);
    }
  }, [design, toast]);

  // Images a document names that are not loaded yet (after Reload latest, which can bring layers with new images).
  const tried = useRef(new Set<string>(design?.missing ?? []));
  useEffect(() => {
    for (const n of doc.nodes) {
      if (n.type !== "image" || images.has(n.assetId) || tried.current.has(n.assetId)) continue;
      const id = n.assetId;
      tried.current.add(id); // once each: a missing image is not asked for again on every edit
      loadAsset(id).then(
        (img) => setImages((m) => new Map(m).set(id, img)),
        () => toast.warning("An image in this design could not be loaded."),
      );
    }
  }, [doc, images, toast]);

  // ── Editing ───────────────────────────────────────────────────────────────
  /** Applies a change to the document as one undo step (or merges into the last one when `key` repeats). */
  const edit = useCallback(
    (change: (d: CanvasDocument) => CanvasDocument, key: string | null = null) => setHistory((h) => commit(h, change(h.present), key)),
    [commit],
  );
  const patch = useCallback((id: string, p: NodePatch, key: string | null = null) => edit((d) => updateNode(d, id, p), key), [edit, updateNode]);

  const add = (node: CanvasNode) => {
    const why = canAdd(doc, node);
    if (why) {
      toast.warning(why);
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
    // Asked before uploading: an upload for a layer that cannot be added would leave a file nothing points to.
    const why = canAdd(doc, createImage(doc, { id: "pending", width: 1, height: 1 }));
    if (why) {
      toast.warning(why);
      return;
    }
    setUploading(true);
    try {
      const asset = await uploadCanvasAsset(file);
      const image = await loadAsset(asset.id); // by id: a layer names its image by id alone
      setImages((m) => new Map(m).set(asset.id, image));
      add(createImage(doc, { ...asset, name: file.name.replace(/\.[^.]+$/, "") }));
    } catch (err) {
      toast.error(canvasProblem(err, "The image could not be added."));
    } finally {
      setUploading(false);
    }
  };

  const onExport = async (options: ExportOptions) => {
    if (!stage.current) return;
    setExporting(true);
    try {
      const blob = await stage.current.exportImage(options);
      download(blob, `${slugOf(name)}${options.multiplier === 2 ? "@2x" : ""}.${options.format === "png" ? "png" : "jpg"}`);
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
    <>
      <CanvasShell
        title={name}
        onRename={design ? rename : undefined}
        nameMaxLength={LIMITS.designName.max}
        status={design ? <SaveStatus info={autosave.info} onRetry={autosave.retry} /> : undefined}
        banner={design && needsBanner(autosave.info.state) ? <SaveBanner state={autosave.info.state} onReload={autosave.reload} onRetry={autosave.retry} /> : undefined}
        onBeforeLeave={design ? beforeLeave : undefined}
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
        actions={
          <>
            {design && <ReviewIndicator beforeLeave={beforeLeave} />}
            {design && (
              <PublishAction
                designId={design.id}
                template={design.template}
                revision={revision}
                version={autosave.version}
                dirty={autosave.info.dirty}
                doc={doc}
                analyse={editableLayers}
                flush={autosave.flush}
                currentVersion={autosave.currentVersion}
                onPublished={setRevision}
              />
            )}
            <ExportMenu width={doc.width} height={doc.height} busy={exporting} onExport={onExport} />
          </>
        }
        layers={
          <LayersPanel
            nodes={doc.nodes}
            selectedId={selectedId}
            onSelect={setSelection}
            onToggleVisible={(id) => edit((d) => updateNode(d, id, { visible: !nodeById(d, id)?.visible }))}
            onMove={(id: string, to: MoveTo) => edit((d) => moveNode(d, id, to))}
            onRename={(id, layerName) => patch(id, { name: layerName })}
            nameMaxLength={LIMITS.nodeName.max}
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
            limits={LIMITS}
            textRoom={selected?.type === "text" ? textRoom(doc, selected.id) : 0}
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

      <ConfirmDialog
        open={leaving !== null}
        onOpenChange={(open) => {
          if (open) return;
          leaving?.(false); // closed any other way (Esc, Cancel): stay
          setLeaving(null);
        }}
        tone="default"
        title="Leave without saving?"
        description="Your latest changes could not be saved yet. If you leave now they are lost."
        confirmLabel="Leave"
        cancelLabel="Stay"
        onConfirm={() => {
          leaving?.(true);
          setLeaving(null);
        }}
      />
    </>
  );
}
