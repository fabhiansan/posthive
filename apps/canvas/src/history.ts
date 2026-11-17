/**
 * Undo/redo as a {past, present, future} reducer. One entry per finished action (a drag, a resize, a
 * typed value), never one per mouse move. Capped, so a long session cannot grow without bound.
 */

export const MAX_HISTORY = 100;

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** The key of the last commit. A commit with the same key replaces the present instead of adding an entry. */
  lastKey: string | null;
}

export const createHistory = <T>(present: T): History<T> => ({ past: [], present, future: [], lastKey: null });

/**
 * Records a new present. Give `key` to a stream of edits that should undo as one (typing in a field,
 * dragging a colour, holding an arrow key): while the key stays the same they overwrite one entry.
 * A new edit clears redo.
 */
export function commit<T>(h: History<T>, next: T, key: string | null = null): History<T> {
  if (Object.is(next, h.present)) return h;
  if (key !== null && key === h.lastKey) return { ...h, present: next, future: [] };
  return { past: [...h.past, h.present].slice(-MAX_HISTORY), present: next, future: [], lastKey: key };
}

/** Ends a stream of keyed edits, so the next one starts a new entry (call it when a field loses focus). */
export const seal = <T>(h: History<T>): History<T> => (h.lastKey === null ? h : { ...h, lastKey: null });

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], lastKey: null };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), lastKey: null };
}

export const canUndo = <T>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T>(h: History<T>): boolean => h.future.length > 0;
