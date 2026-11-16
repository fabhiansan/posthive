"use client";

import { useEffect, useState } from "react";
import { loadEditorFonts } from "@/lib/canvas";
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

/**
 * Loads what the editor needs (the Konva engine and the editor fonts) and tells the Canvas loader
 * how each is going. Returns the engine once it, the design document and the fonts are all ready.
 * Konva needs a browser, so the engine is imported here and never during server rendering.
 */
export function useCanvasBootstrap(): CanvasEngine | null {
  const report = useBootReport();
  const [engine, setEngine] = useState<CanvasEngine | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [engineTry, setEngineTry] = useState(0);
  const [fontsTry, setFontsTry] = useState(0);

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
        if (live) report("engine", { state: "error", message: "The editor could not be loaded. Check your connection.", retry: () => setEngineTry((n) => n + 1) });
      },
    );
    return () => { live = false; };
  }, [engineTry, report]);

  // The blank design is created in the engine's own defaults, so it is ready as soon as the engine is.
  useEffect(() => {
    report("document", { state: engine ? "done" : "pending" });
  }, [engine, report]);

  useEffect(() => {
    let live = true;
    report("assets", { state: "active" });
    loadEditorFonts().then(
      () => {
        if (!live) return;
        setFontsReady(true);
        report("assets", { state: "done" });
      },
      () => {
        if (live) report("assets", { state: "error", message: "The editor fonts could not be loaded.", retry: () => setFontsTry((n) => n + 1) });
      },
    );
    return () => { live = false; };
  }, [fontsTry, report]);

  return fontsReady ? engine : null;
}
