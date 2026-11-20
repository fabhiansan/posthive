"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasDocument } from "posthive-canvas";
import { AssetLoadError, getDesign, getInstance, loadAsset, loadEditorFonts, type Design, type InstanceDetail } from "@/lib/canvas";
import { useBootReport } from "./CanvasBoot";

export type CanvasEngine = typeof import("posthive-canvas");

let engineLoad: Promise<CanvasEngine> | null = null;

// One import for the whole session; a failed one is forgotten so Retry can try again.
function loadEngine(): Promise<CanvasEngine> {
  engineLoad ??= import("posthive-canvas").catch((err) => {
    engineLoad = null;
    throw err;
  });
  return engineLoad;
}

/** The decoded images of an opened design. */
export interface LoadedImages {
  images: ReadonlyMap<string, HTMLImageElement>;
  /** Images that could not be loaded for good (gone, or the API address is not set): their layers show a grey box. */
  missing: string[];
  /** The API address is not configured, which is why the images are missing. Not the design's fault. */
  badApiBase: boolean;
}

/** A saved design, opened: its document and the decoded images it draws. */
export interface LoadedDesign extends LoadedImages {
  id: string;
  version: number;
  name: string;
  document: CanvasDocument;
  /** The template this design is made for, and its latest published revision (null: not attached, or none yet). */
  template: Design["template"];
  latestRevision: Design["latestRevision"];
}

/** Why a design cannot be opened at all. */
export type DesignProblem = "not-found" | "forbidden" | "invalid";

export interface Bootstrap<L = LoadedDesign> {
  /** Set once the engine, the fonts and (for a saved design) the design and its images are all ready. */
  engine: CanvasEngine | null;
  design: L | null;
  problem: DesignProblem | null;
  /** Something that may work on a second try. Also reported to the loader, which is gone after the first open. */
  failure: { message: string; retry: () => void } | null;
}

/** What the hook needs of anything it opens: an id, the version the autosave starts from, a name and the document it draws. */
export interface Openable {
  id: string;
  version: number;
  name: string;
  document: CanvasDocument;
}

/** How to open one kind of design: how to fetch it, and which images it draws (loaded before the editor opens). */
export interface DesignSource<R extends Openable> {
  load(id: string): Promise<R>;
  imageIds(record: R): string[];
}

interface Images {
  images: Map<string, HTMLImageElement>;
  missing: string[];
  badBase: boolean;
  /** At least one image failed in a way that a retry may fix (a lost connection, a server error). */
  failed: boolean;
}

const isDocument = (d: unknown): d is CanvasDocument => typeof d === "object" && d !== null && (d as CanvasDocument).schemaVersion === 1 && Array.isArray((d as CanvasDocument).nodes);

export const assetIdsOf = (doc: CanvasDocument): string[] => [...new Set(doc.nodes.flatMap((n) => (n.type === "image" ? [n.assetId] : [])))];

/** Never rejects: each image ends as loaded, missing (it will not come back) or failed (it may, on a retry). */
async function loadImages(ids: string[]): Promise<Images> {
  const out: Images = { images: new Map(), missing: [], badBase: false, failed: false };
  await Promise.all(
    ids.map(async (id) => {
      try {
        out.images.set(id, await loadAsset(id));
      } catch (err) {
        const code = err instanceof AssetLoadError ? err.code : "FAILED";
        if (code === "FAILED") out.failed = true;
        else out.missing.push(id);
        if (code === "BAD_API_BASE") out.badBase = true;
      }
    }),
  );
  return out;
}

type Stage = "engine" | "document" | "assets";

/** The designer's own design: fetched by id, and it draws the images its document names. */
const designerSource: DesignSource<Design> = { load: async (id) => (await getDesign(id)).design, imageIds: (d) => assetIdsOf(d.document) };

/** A Marketing design: its revision's document, and the images that revision draws plus the ones Marketing replaced them with. */
export const instanceSource: DesignSource<InstanceDetail> = {
  load: async (id) => (await getInstance(id)).instance,
  imageIds: (i) => [...new Set([...assetIdsOf(i.document), ...i.overrides.flatMap((o) => ("assetId" in o ? [o.assetId] : []))])],
};

/**
 * Loads what the editor needs and tells the Canvas loader how each part is going: the Konva engine, the editor
 * fonts and, for a saved design (`designId`), the design itself and its images. Pass a designId that does not
 * change during the hook's life (key the page by it). Returns the engine only when everything is ready. Konva needs
 * a browser, so the engine is imported here and never during server rendering.
 */
export function useCanvasBootstrap(designId?: string): Bootstrap {
  return useOpenedDesign<Design>(designId, designerSource);
}

/**
 * The same, for any kind of saved design: `source` says how to fetch it and which images it draws (a Marketing design draws
 * its revision's images and the ones it replaced them with). Pass a `source` that does not change (a module-level
 * constant): it is read when a load runs, never in an effect's dependencies, so a new object per render does not refetch.
 */
export function useOpenedDesign<R extends Openable>(designId: string | undefined, source: DesignSource<R>): Bootstrap<R & LoadedImages> {
  const report = useBootReport();
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const [engine, setEngine] = useState<CanvasEngine | null>(null);
  const [design, setDesign] = useState<R | null>(null);
  const [problem, setProblem] = useState<DesignProblem | null>(null);
  const [loaded, setLoaded] = useState<Images | null>(null);
  const [failures, setFailures] = useState<Partial<Record<Stage, { message: string; retry: () => void }>>>({});
  const [engineTry, setEngineTry] = useState(0);
  const [designTry, setDesignTry] = useState(0);
  const [assetsTry, setAssetsTry] = useState(0);

  /** Tells the loader and the page. A retry first clears the failure, then asks the stage to run again. */
  const fail = (stage: Stage, message: string, again: () => void) => {
    const retry = () => {
      setFailures((f) => ({ ...f, [stage]: undefined }));
      again();
    };
    report(stage, { state: "error", message, retry });
    setFailures((f) => ({ ...f, [stage]: { message, retry } }));
  };

  useEffect(() => {
    let live = true;
    report("engine", { state: "active" });
    loadEngine().then(
      (e) => {
        if (!live) return;
        setEngine(e);
        report("engine", { state: "done" });
      },
      () => {
        if (live) fail("engine", "The editor could not be loaded. Check your connection.", () => setEngineTry((n) => n + 1));
      },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fail` only closes over stable setters and `report`
  }, [engineTry, report]);

  // The local editor's blank design is made by the engine itself, so it is ready as soon as the engine is.
  useEffect(() => {
    if (!designId) report("document", { state: engine ? "done" : "pending" });
  }, [designId, engine, report]);

  // A saved design: fetched once; a missing or forbidden one is a screen of its own, not a loader error.
  useEffect(() => {
    if (!designId) return;
    let live = true;
    report("document", { state: "active" });
    sourceRef.current.load(designId).then(
      (d) => {
        if (!live) return;
        if (!isDocument(d.document)) {
          setProblem("invalid");
          report("document", { state: "na" });
          report("assets", { state: "na" });
          return;
        }
        setDesign(d);
        report("document", { state: "done", detail: d.name });
      },
      (err: unknown) => {
        if (!live) return;
        const status = (err as { status?: number } | null)?.status;
        if (status === 404 || status === 403) {
          setProblem(status === 404 ? "not-found" : "forbidden");
          report("document", { state: "na" });
          report("assets", { state: "na" });
          return;
        }
        fail("document", "The design could not be loaded. Check your connection.", () => setDesignTry((n) => n + 1));
      },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fail` only closes over stable setters and `report`
  }, [designId, designTry, report]);

  // Fonts, and the images of a saved design. Konva does not redraw when either arrives late, so both are
  // ready before the editor opens. A missing image does not stop it opening (its layer is a grey box).
  useEffect(() => {
    if (designId && !design) return;
    let live = true;
    report("assets", { state: "active" });
    Promise.all([loadEditorFonts().then(() => true, () => false), loadImages(design ? sourceRef.current.imageIds(design) : [])]).then(([fontsOk, images]) => {
      if (!live) return;
      if (!fontsOk) return fail("assets", "The editor fonts could not be loaded.", () => setAssetsTry((n) => n + 1));
      if (images.failed) return fail("assets", "Some images could not be loaded. Check your connection.", () => setAssetsTry((n) => n + 1));
      setLoaded(images);
      report("assets", { state: "done" });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fail` only closes over stable setters and `report`
  }, [designId, design, assetsTry, report]);

  const ready = engine !== null && loaded !== null && (!designId || design !== null);
  const loadedDesign = useMemo<(R & LoadedImages) | null>(
    () => (design && loaded ? { ...design, images: loaded.images, missing: loaded.missing, badApiBase: loaded.badBase } : null),
    [design, loaded],
  );

  return {
    engine: ready ? engine : null,
    design: ready ? loadedDesign : null,
    problem,
    failure: failures.engine ?? failures.document ?? failures.assets ?? null,
  };
}
