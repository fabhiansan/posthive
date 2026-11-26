"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { CanvasDocument, CanvasStageHandle, ExportOptions, History, OverrideEntry } from "posthive-canvas";
import { SaveIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import type { Saved } from "@/lib/autosave";
import { STORAGE_UNSUPPORTED_MESSAGE, canvasProblem, editorFonts, getInstance, liveReview, loadAsset, saveInstance, uploadCanvasAsset, type InstanceDetail } from "@/lib/canvas";
import { attachDesignExport, exportFormatsFor, formatFromMime, notifyDesignExportSaved, uploadDesignFile } from "@/lib/designExport";
import { fetchJob } from "@/lib/jobActions";
import { jpegToPdf } from "@/lib/pdf";
import type { CanvasEngine, LoadedImages } from "./useCanvasBootstrap";
import { download, isTyping, slugOf } from "./CanvasEditor";
import { CanvasShell } from "./CanvasShell";
import { ExportMenu } from "./ExportMenu";
import { FieldInspector, type FieldView } from "./FieldInspector";
import { FieldsPanel, type FieldRow } from "./FieldsPanel";
import { ReviewAction } from "./ReviewAction";
import { SaveDraftAction } from "./SaveDraftAction";
import { needsBanner, SaveBanner, SaveStatus } from "./SaveStatus";
import { Toolbar } from "./Toolbar";
import { useAutosave } from "./useAutosave";

const ZOOM_STEP = 1.25;

/** What the person has changed, as the list the server stores. Read only: every edit makes a new list (or returns this one). */
type Overrides = readonly OverrideEntry[];

/**
 * The editor for a Marketing design: a published revision plus a list of changes. The person can change the text and
 * replace the images the design team opened up (the revision's manifest) and nothing else: no layer can be added, moved,
 * resized, restyled or deleted, and the server refuses the same things. What is on the stage is the revision's document
 * with the changes applied in memory (applyOverrides); only the list of changes is ever saved. Mount it once per design
 * (key it by id). The Konva engine comes in as a prop because it loads in the browser only.
 */
export function InstanceEditor({ engine, instance }: { engine: CanvasEngine; instance: InstanceDetail & LoadedImages }) {
  const { CanvasStage, applyOverrides, setOverride, clearOverride, sameOverrides, nodeById, textRoom, cleanName, createHistory, commit, seal, undo, redo, canUndo, canRedo, ExportError, LIMITS } = engine;
  const toast = useToast();
  const router = useRouter();
  // The compose draft that opened this design (Path A): Save exports and attaches there. Opened from /canvas, there is none.
  const postId = useSearchParams().get("post");
  const [savingExport, setSavingExport] = useState(false);

  const base: CanvasDocument = instance.document;
  const manifest = instance.manifest;

  const [history, setHistory] = useState<History<Overrides>>(() => createHistory<Overrides>(instance.overrides));
  const [name, setName] = useState(instance.name);
  const [selection, setSelection] = useState<string | null>(null);
  const [images, setImages] = useState<ReadonlyMap<string, HTMLImageElement>>(() => instance.images);
  const [zoom, setZoom] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [textSignal, setTextSignal] = useState(0);
  const [leaving, setLeaving] = useState<((leave: boolean) => void) | null>(null);
  const stage = useRef<CanvasStageHandle>(null);
  const fonts = useMemo(() => editorFonts(), []);

  const overrides = history.present;
  // The design as it looks with the changes: composed here, in memory, each time. Never saved, never sent anywhere.
  const effective = useMemo(() => applyOverrides(base, manifest, overrides), [applyOverrides, base, manifest, overrides]);
  const selectable = useMemo(() => new Set(manifest.fields.map((f) => f.nodeId)), [manifest]);
  const selectedId = selection !== null && selectable.has(selection) ? selection : null;

  // ── Saving ────────────────────────────────────────────────────────────────
  /** Reload latest after a conflict: the server's list replaces everything here, history included. */
  const onReload = useCallback(
    (next: Saved<Overrides>) => {
      setHistory(createHistory<Overrides>(next.doc));
      setName(next.name);
      setSelection(null);
    },
    [createHistory],
  );
  // Stable: the autosave makes its controller when this changes, so it is memoized on the loaded design (never rebuilt per render).
  const savedItem = useMemo(() => ({ id: instance.id, version: instance.version, name: instance.name, value: instance.overrides }), [instance]);
  const autosave = useAutosave<Overrides>({
    item: savedItem,
    value: overrides,
    name,
    // The WHOLE list, every time (not a patch): what the server stores is exactly this, and a field left out is back to the revision's value.
    save: (id, version, snapshot) => saveInstance(id, { version, overrides: [...snapshot.doc], name: snapshot.name }),
    fetchLatest: async (id) => {
      const { instance: latest } = await getInstance(id);
      return { version: latest.version, doc: latest.overrides, name: latest.name };
    },
    onReload,
  });

  // The review facts as they are now: the newest answer is the server's, and "unsubmitted changes" follows what is on screen.
  const review = useMemo(
    () => liveReview(instance.review, instance.submitted, { name, overrides }, sameOverrides),
    [instance.review, instance.submitted, name, overrides, sameOverrides],
  );

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
    if (instance.badApiBase) toast.error("Images can't be loaded because the API address is not configured.");
    else if (instance.noStorage) toast.warning(STORAGE_UNSUPPORTED_MESSAGE);
    else if (instance.missing.length > 0) {
      toast.warning(`${instance.missing.length === 1 ? "An image" : `${instance.missing.length} images`} in this design could not be found and ${instance.missing.length === 1 ? "is" : "are"} shown as grey boxes.`);
    }
  }, [instance, toast]);

  // Images the design draws that are not loaded yet (after Reload latest, which can bring a different replacement).
  const tried = useRef(new Set<string>(instance.missing));
  useEffect(() => {
    for (const n of effective.nodes) {
      if (n.type !== "image" || images.has(n.assetId) || tried.current.has(n.assetId)) continue;
      const id = n.assetId;
      tried.current.add(id); // once each: a missing image is not asked for again on every edit
      loadAsset(id).then(
        (img) => setImages((m) => new Map(m).set(id, img)),
        () => toast.warning("An image in this design could not be loaded."),
      );
    }
  }, [effective, images, toast]);

  // ── Editing: the only two things a person can do ──────────────────────────
  /** Types into a text field. Typing in one field is one undo step (merged by its key). */
  const onText = (nodeId: string, text: string) => setHistory((h) => commit(h, setOverride(base, manifest, h.present, { nodeId, text }), `text:${nodeId}`));

  /** Replaces an image: the file is uploaded and decoded first, so the stage never shows a grey box for it. */
  const onImage = async (nodeId: string, file: File) => {
    setUploading(true);
    try {
      const asset = await uploadCanvasAsset(file);
      const image = await loadAsset(asset.id); // by id: an override names its image by id alone
      setImages((m) => new Map(m).set(asset.id, image));
      setHistory((h) => commit(h, setOverride(base, manifest, h.present, { nodeId, assetId: asset.id })));
    } catch (err) {
      toast.error(canvasProblem(err, "The image could not be replaced."));
    } finally {
      setUploading(false);
    }
  };

  const onReset = (nodeId: string) => setHistory((h) => commit(h, clearOverride(h.present, nodeId)));

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

  /**
   * Save (Path A): the design is already autosaved; this draws the file(s) the draft's channels need, stores them and
   * attaches them to the draft, then returns to it. It never submits the post and never touches the compose form: the
   * attach endpoint writes only content.canvasExport, so unsaved fields in the other tab stay.
   */
  const saveToDraft = async () => {
    const handle = stage.current;
    if (!postId || !handle || savingExport) return;
    setSavingExport(true);
    try {
      if (!(await autosave.flush())) {
        toast.error("Your latest changes could not be saved yet. Try again.");
        return;
      }
      const job = await fetchJob(postId);
      if (job.status !== "draft" || job.approvalStatus === "pending") {
        toast.error("This post is not a plain draft any more. Open it and send it back to Draft first.");
        return;
      }
      const platforms = job.targets.map((t) => t.account?.platform).filter((p): p is string => Boolean(p));
      const formats = exportFormatsFor(platforms);
      // One JPEG serves both the PDF page and Instagram; the engine draws it once.
      const jpeg = formats.some((f) => f === "jpeg" || f === "pdf") ? await handle.exportImage({ format: "jpeg", multiplier: 1 }) : null;
      // The format is the one the SERVER stored (the upload route reports it), never the one we asked it to export:
      // the two can only agree, but claiming the stored one is what keeps the attach's extension check exact.
      const stored = async (blob: Blob, name: string) => {
        const { url, mimeType } = await uploadDesignFile(blob, name);
        const format = formatFromMime(mimeType);
        if (!format) throw new Error("The design was stored in a format this draft cannot use.");
        return { format, mediaUrl: url };
      };
      const files: Array<{ format: "png" | "jpeg" | "pdf"; mediaUrl: string }> = [];
      if (formats.includes("pdf") && jpeg) files.push(await stored(await jpegToPdf(jpeg, effective.width, effective.height), "design.pdf"));
      if (formats.includes("jpeg") && jpeg) files.push(await stored(jpeg, "design.jpg"));
      if (formats.includes("png")) files.push(await stored(await handle.exportImage({ format: "png", multiplier: 1 }), "design.png"));
      const version = autosave.currentVersion() ?? instance.version;
      await attachDesignExport(postId, { instanceId: instance.id, version, files });
      notifyDesignExportSaved(postId);
      toast.success("Design saved to your draft.");
      router.push(`/jobs/${encodeURIComponent(postId)}/edit`);
    } catch (err) {
      toast.error(err instanceof ExportError ? err.message : canvasProblem(err, "The design could not be saved to the draft."));
    } finally {
      setSavingExport(false);
    }
  };

  // Keyboard: undo and redo, and Escape. Nothing here moves or deletes a layer. Typing in a field keeps its own keys.
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
      } else if (!mod && e.key === "Escape") {
        setSelection(null);
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [redo, undo]);

  // ── What the side panels show ─────────────────────────────────────────────
  const rows = useMemo<FieldRow[]>(
    () =>
      manifest.fields.map((f) => ({
        nodeId: f.nodeId,
        kind: f.kind,
        name: nodeById(base, f.nodeId)?.name ?? f.nodeId,
        changed: overrides.some((o) => o.nodeId === f.nodeId),
      })),
    [manifest, base, overrides, nodeById],
  );

  const field: FieldView | null = useMemo(() => {
    if (!selectedId) return null;
    const spec = manifest.fields.find((f) => f.nodeId === selectedId);
    const shown = nodeById(effective, selectedId);
    const original = nodeById(base, selectedId);
    if (!spec || !shown || !original) return null;
    const changed = overrides.some((o) => o.nodeId === selectedId);
    if (spec.kind === "text" && shown.type === "text" && original.type === "text") {
      return { nodeId: selectedId, kind: "text", name: shown.name, text: shown.text, original: original.text, changed, room: textRoom(effective, selectedId) };
    }
    return spec.kind === "image" ? { nodeId: selectedId, kind: "image", name: shown.name, changed } : null;
  }, [selectedId, manifest, effective, base, overrides, nodeById, textRoom]);

  return (
    <>
      <CanvasShell
        title={name}
        onRename={rename}
        nameMaxLength={LIMITS.designName.max}
        status={<SaveStatus info={autosave.info} onRetry={autosave.retry} />}
        banner={needsBanner(autosave.info.state) ? <SaveBanner state={autosave.info.state} onReload={autosave.reload} onRetry={autosave.retry} /> : undefined}
        onBeforeLeave={beforeLeave}
        propertiesSignal={textSignal}
        toolbar={
          <Toolbar
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
            <span className="hidden type-body-r-xs text-muted xl:inline">Based on revision {instance.baseRevision.number}</span>
            {postId ? (
              <Button
                size="sm"
                onClick={() => void saveToDraft()}
                disabled={savingExport || autosave.info.state === "archived" || autosave.info.state === "deleted"}
                aria-busy={savingExport}
                title="Save the design and attach it to the post"
              >
                <SaveIcon /> <span className="max-sm:sr-only">{savingExport ? "Saving…" : "Save"}</span>
              </Button>
            ) : (
              <SaveDraftAction flush={autosave.flush} disabled={autosave.info.state === "archived" || autosave.info.state === "deleted"} />
            )}
            <ReviewAction designId={instance.id} review={review} flush={autosave.flush} />
            <ExportMenu width={effective.width} height={effective.height} busy={exporting} onExport={onExport} />
          </>
        }
        layers={<FieldsPanel fields={rows} lockedCount={Math.max(0, base.nodes.length - manifest.fields.length)} selectedId={selectedId} onSelect={setSelection} />}
        properties={<FieldInspector field={field} onText={onText} onImage={(id, file) => void onImage(id, file)} onReset={onReset} onSeal={() => setHistory(seal)} uploading={uploading} focusSignal={textSignal} />}
      >
        <CanvasStage
          ref={stage}
          mode="marketing"
          selectable={selectable}
          doc={effective}
          selectedId={selectedId}
          images={images}
          fonts={fonts}
          onSelect={(id) => setSelection(id !== null && selectable.has(id) ? id : null)}
          onChange={() => {}} // nothing can be dragged or resized in this mode
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
