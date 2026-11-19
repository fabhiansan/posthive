"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { createAutosave, type Autosave, type AutosaveInfo, type Saved } from "@/lib/autosave";
import { useUnsavedChanges } from "@/lib/session";

/** What a saved thing is to the autosave: its id, the version the server confirmed, what is being edited, and its name. */
interface SavedItem<D> {
  id: string;
  version: number;
  name: string;
  /** The value being edited and compared: a designer's document, or a Marketing design's list of changes. */
  value: D;
}

/**
 * Connects a saved design to the autosave controller (lib/autosave.ts, where the rules and their tests are). It is generic
 * over what is saved (D): a designer's whole document, or the list of changes of a Marketing design. The two calls that
 * differ are passed in; everything else (when to save, retries, conflicts, leaving the page) is the same for both.
 * Without `item` (the local editor) it does nothing. The editor must be mounted once per design (key it by id), and its
 * history must start from `item.value` itself, the same object, so "nothing changed" is exact.
 *
 * `item` must be STABLE (memoize it on the loaded design, as both editors do): the controller is created when it changes,
 * so a new object on every render would throw the controller, and anything it still owes, away each time.
 * `save` and `fetchLatest` are read when a save runs, not when the controller is made, so a caller may pass new functions
 * each render.
 *
 * Leaving the page, in layers:
 *  1. the tab goes to the background: a normal save is sent while the page is alive (visibilitychange);
 *  2. the tab closes or reloads: the browser asks first while there are unsaved changes (beforeunload);
 *  3. our own links save first (flush(), asked by the shell);
 *  4. anything else that unmounts the editor (browser Back): the controller finishes its saves on its own, and
 *     reports through a toast if the last ones could not be saved;
 *  5. the session expires: the unsaved-changes registry makes the app offer to save instead of redirecting.
 */
export function useAutosave<D>({
  item,
  value,
  name,
  save,
  fetchLatest,
  onReload,
}: {
  item: SavedItem<D> | undefined;
  value: D;
  name: string;
  /** Sends one save on top of `version`; resolves with the new version. */
  save(id: string, version: number, snapshot: { doc: D; name: string }): Promise<{ version: number }>;
  /** The design as the server has it now (asked after a 409). */
  fetchLatest(id: string): Promise<Saved<D>>;
  onReload(next: Saved<D>): void;
}) {
  const toast = useToast();
  const controller = useRef<Autosave<D> | null>(null);
  const [info, setInfo] = useState<AutosaveInfo>({ state: "saved", dirty: false });
  // The version the server last confirmed, for the page to compare with the latest published revision.
  const [version, setVersion] = useState(item?.version ?? 0);
  // The latest functions, so the controller (made once per design) never calls a stale one.
  const calls = useRef({ save, fetchLatest });
  calls.current = { save, fetchLatest };

  useEffect(() => {
    if (!item) return;
    const c: Autosave<D> = createAutosave<D>(
      { version: item.version, doc: item.value, name: item.name },
      {
        save: (version, snapshot) => calls.current.save(item.id, version, snapshot),
        fetchLatest: () => calls.current.fetchLatest(item.id),
        onState: (next) => {
          setInfo(next);
          setVersion(c.version);
        },
        // The editor is gone, so this is the only way the person learns that their last changes did not reach the server.
        onAbandon: (_reason, snapshot, message) => toast.error(`Your last changes to “${snapshot.name}” could not be saved. ${message}`),
      },
    );
    controller.current = c;
    return () => {
      controller.current = null;
      c.dispose(); // finishes any save still owed; it does not cancel it
    };
  }, [item, toast]);

  // After the effect above on purpose: a new controller is created before it hears about the document.
  useEffect(() => {
    controller.current?.update(value, name);
  }, [value, name, item]);

  useUnsavedChanges("canvas-design", item !== undefined && info.dirty);

  useEffect(() => {
    if (!item) return;
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
  }, [item]);

  const retry = useCallback(() => controller.current?.retry(), []);
  const flush = useCallback(() => controller.current?.flush() ?? Promise.resolve(true), []);
  /** The version the server last confirmed, read at the moment it is needed (a publish names it right after flush()). */
  const currentVersion = useCallback(() => controller.current?.version ?? null, []);
  /** Reload latest after a conflict: takes the server's version and discards the unsaved changes here. */
  const reload = useCallback(() => {
    const c = controller.current;
    const latest = c?.conflict;
    if (!c || !latest) return;
    c.reset(latest);
    setVersion(latest.version);
    onReload(latest);
  }, [onReload]);

  return { info, version, retry, flush, currentVersion, reload };
}
