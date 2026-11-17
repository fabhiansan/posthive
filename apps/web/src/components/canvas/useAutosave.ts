"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasDocument } from "posthive-canvas";
import { useToast } from "@/components/Toast";
import { createAutosave, type Autosave, type AutosaveInfo, type Saved } from "@/lib/autosave";
import { getDesign, saveDesign } from "@/lib/canvas";
import { useUnsavedChanges } from "@/lib/session";

interface SavedDesign {
  id: string;
  version: number;
  name: string;
  document: CanvasDocument;
}

/**
 * Connects a saved design to the autosave controller (lib/autosave.ts, where the rules and their tests are).
 * Without `design` (the local editor) it does nothing. The editor must be mounted once per design (key it by id),
 * and its history must start from `design.document` itself, the same object, so "nothing changed" is exact.
 *
 * Leaving the page, in layers:
 *  1. the tab goes to the background: a normal save is sent while the page is alive (visibilitychange);
 *  2. the tab closes or reloads: the browser asks first while there are unsaved changes (beforeunload);
 *  3. our own links save first (flush(), asked by the shell);
 *  4. anything else that unmounts the editor (browser Back): the controller finishes its saves on its own, and
 *     reports through a toast if the last ones could not be saved;
 *  5. the session expires: the unsaved-changes registry makes the app offer to save instead of redirecting.
 */
export function useAutosave({ design, doc, name, onReload }: { design: SavedDesign | undefined; doc: CanvasDocument; name: string; onReload(next: Saved<CanvasDocument>): void }) {
  const toast = useToast();
  const controller = useRef<Autosave<CanvasDocument> | null>(null);
  const [info, setInfo] = useState<AutosaveInfo>({ state: "saved", dirty: false });

  useEffect(() => {
    if (!design) return;
    const c = createAutosave<CanvasDocument>(
      { version: design.version, doc: design.document, name: design.name },
      {
        save: (version, snapshot) => saveDesign(design.id, { version, document: snapshot.doc, name: snapshot.name }),
        fetchLatest: async () => {
          const { design: latest } = await getDesign(design.id);
          return { version: latest.version, doc: latest.document, name: latest.name };
        },
        onState: setInfo,
        // The editor is gone, so this is the only way the person learns that their last changes did not reach the server.
        onAbandon: (_reason, snapshot, message) => toast.error(`Your last changes to “${snapshot.name}” could not be saved. ${message}`),
      },
    );
    controller.current = c;
    return () => {
      controller.current = null;
      c.dispose(); // finishes any save still owed; it does not cancel it
    };
  }, [design, toast]);

  // After the effect above on purpose: a new controller is created before it hears about the document.
  useEffect(() => {
    controller.current?.update(doc, name);
  }, [doc, name, design]);

  useUnsavedChanges("canvas-design", design !== undefined && info.dirty);

  useEffect(() => {
    if (!design) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (!controller.current?.info.dirty) return;
      e.preventDefault();
      e.returnValue = ""; // some browsers need this for the prompt
    };
    const hide = () => {
      if (document.visibilityState === "hidden") void controller.current?.flush();
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [design]);

  const retry = useCallback(() => controller.current?.retry(), []);
  const flush = useCallback(() => controller.current?.flush() ?? Promise.resolve(true), []);
  /** Reload latest after a conflict: takes the server's version and discards the unsaved changes here. */
  const reload = useCallback(() => {
    const c = controller.current;
    const latest = c?.conflict;
    if (!c || !latest) return;
    c.reset(latest);
    onReload(latest);
  }, [onReload]);

  return { info, retry, flush, reload };
}
