// Autosave for a saved design: when a save goes out, one request at a time, what each answer means, and what
// happens when the editor goes away. No React and no network of its own: the request, the timers and the UI are
// passed in, so every rule is tested with fake timers (autosave.test.ts).
//
// Two separate mechanisms, never mixed up:
//  - generation: which *document state* an answer belongs to. Only reset() (Reload latest) changes it, and an
//    answer from an older generation is dropped.
//  - disposed: the editor is gone, so nothing may talk to the UI any more. dispose() sets it. It does NOT touch
//    the generation, so a request already in flight is still answered and its version is still adopted, and
//    anything newer is still saved. Nothing dirty is dropped just because the editor unmounted.

export interface Snapshot<D> {
  doc: D;
  name: string;
}

/** What the server has confirmed. */
export interface Saved<D> extends Snapshot<D> {
  version: number;
}

export type SaveState = "saved" | "dirty" | "saving" | "retrying" | "failed" | "rejected" | "conflict" | "deleted" | "archived" | "forbidden" | "session";

/** Why a dirty snapshot could not be saved after the editor was gone. */
export type AbandonReason = "conflict" | "rejected" | "forbidden" | "deleted" | "archived" | "session" | "network";

export interface AutosaveInfo {
  state: SaveState;
  /** The editor holds something the server has not confirmed. */
  dirty: boolean;
  /** For failed and rejected: what went wrong, in words for the person. */
  message?: string;
}

export interface AutosaveDeps<D> {
  /** Sends one save on top of `version`. Resolves with the new version; throws what apiFetch throws (an Error with `status` and `data`). */
  save(version: number, snapshot: Snapshot<D>): Promise<{ version: number }>;
  /** The design as the server has it now. Asked after a 409. */
  fetchLatest(): Promise<Saved<D>>;
  /** Called when the state changes, never after dispose(). */
  onState?(info: AutosaveInfo): void;
  /** Called once, after dispose(), when the newest dirty snapshot could not be saved: it would otherwise be lost silently. */
  onAbandon?(reason: AbandonReason, snapshot: Snapshot<D>, message: string): void;
}

export interface Autosave<D> {
  /** The editor's current document and name. Call it on every change; it is cheap. */
  update(doc: D, name: string): void;
  /** Saves now. Resolves true when everything is saved, false when it could not be (conflict, error, retrying). */
  flush(): Promise<boolean>;
  /** Tries again after "failed", "rejected" or "session". */
  retry(): void;
  /** Reload latest: the editor takes this version, and its own unsaved changes are discarded. */
  reset(next: Saved<D>): void;
  /** The editor is gone. The pending save pipeline finishes on its own. */
  dispose(): void;
  readonly info: AutosaveInfo;
  /** After a conflict: the server's version, ready for reset(). */
  readonly conflict: Saved<D> | null;
  /** The version the server last confirmed: what a publish names. Only meaningful once flush() has resolved true. */
  readonly version: number;
}

export const DEBOUNCE_MS = 1500;
/** A save goes out at least this often while the person keeps editing, so dragging or typing cannot starve it. */
export const MAX_WAIT_MS = 10_000;
export const RETRY_DELAYS_MS = [2000, 5000, 15_000] as const;

/** Two JSON values are the same: key order does not matter (Postgres jsonb reorders keys) and a key set to undefined is absent. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((k) => left[k] !== undefined);
  return keys.length === Object.keys(right).filter((k) => right[k] !== undefined).length && keys.every((k) => Object.hasOwn(right, k) && sameJson(left[k], right[k]));
}

type Halt = "conflict" | "deleted" | "archived" | "forbidden" | "session";
type Verdict = { kind: "conflict" | "deleted" | "archived" | "forbidden" | "session" | "rejected" | "transient"; message: string };

const HALT_MESSAGE: Record<Halt, string> = {
  conflict: "This design was changed somewhere else.",
  deleted: "This design was deleted.",
  archived: "This design was archived.",
  forbidden: "Designs are managed by the design team.",
  session: "Your session ended, so this could not be saved.",
};

/** What an error from the save request means. No status at all is a network failure. */
function judge(err: unknown): Verdict {
  const status = (err as { status?: number } | null)?.status;
  const sent = (err as { data?: { error?: string } } | null)?.data?.error;
  const code = (err as { data?: { code?: string } } | null)?.data?.code;
  if (status === undefined) return { kind: "transient", message: "Couldn't reach the server." };
  if (status === 409) return { kind: "conflict", message: HALT_MESSAGE.conflict };
  // A 404 is "gone" unless the server says it is archived: the design is still there, but frozen (phase 6).
  if (status === 404) return code === "DESIGN_ARCHIVED" ? { kind: "archived", message: HALT_MESSAGE.archived } : { kind: "deleted", message: HALT_MESSAGE.deleted };
  if (status === 403) return { kind: "forbidden", message: HALT_MESSAGE.forbidden };
  if (status === 401) return { kind: "session", message: HALT_MESSAGE.session };
  // The global error handler words a 413 as {error: "FastifyError"}, so the message is written here.
  if (status === 413) return { kind: "rejected", message: "This design is too large to save." };
  if (status === 408 || status === 429 || status >= 500) return { kind: "transient", message: "The server could not save right now." };
  return { kind: "rejected", message: sent ?? (err instanceof Error ? err.message : "This design could not be saved.") };
}

export function createAutosave<D>(initial: Saved<D>, deps: AutosaveDeps<D>): Autosave<D> {
  let saved: Saved<D> = initial;
  let current: Snapshot<D> = { doc: initial.doc, name: initial.name };
  let generation = 0;
  let disposed = false;
  let busy = false; // a request (or the lookup after a 409) is in flight
  let halted: Halt | null = null;
  let failure: { kind: "retrying" | "failed" | "rejected"; message: string } | null = null;
  let latest: Saved<D> | null = null;
  // Snapshots whose request got no answer (a network error, a 5xx): the server may have stored any of them. A 409
  // is not a conflict when the server holds one of these (see onFailed). Cleared whenever a version is confirmed.
  // The cap is one more than the retry schedule, so a whole run of retries fits.
  const maybeLanded: Array<Snapshot<D>> = [];
  let retryCount = 0;
  let abandoned = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastEmitted = "";
  const waiters: Array<(ok: boolean) => void> = [];

  const isDirty = () => current.doc !== saved.doc || current.name !== saved.name;
  const stateNow = (): SaveState => halted ?? (busy ? "saving" : (failure?.kind ?? (isDirty() ? "dirty" : "saved")));
  const infoNow = (): AutosaveInfo => ({ state: stateNow(), dirty: isDirty(), message: halted ? HALT_MESSAGE[halted] : failure?.message });

  function emit() {
    if (disposed) return; // never a state update (or a React render) after the editor is gone
    const info = infoNow();
    const key = `${info.state}|${info.dirty}|${info.message ?? ""}`;
    if (key === lastEmitted) return;
    lastEmitted = key;
    deps.onState?.(info);
  }

  function clearTimers() {
    clearTimeout(debounceTimer);
    clearTimeout(maxTimer);
    clearTimeout(retryTimer);
    debounceTimer = maxTimer = retryTimer = undefined;
  }

  /** Everyone waiting in flush() learns whether it all got saved. Called whenever the pipeline goes idle. */
  function settle() {
    const ok = !isDirty() && !halted && !failure;
    waiters.splice(0).forEach((resolve) => resolve(ok));
  }

  /** The newest dirty snapshot could not be saved and nobody is looking any more: say so once, instead of dropping it silently. */
  function abandon(reason: AbandonReason, message: string) {
    if (!disposed || abandoned || !isDirty()) return;
    abandoned = true;
    deps.onAbandon?.(reason, { doc: current.doc, name: current.name }, message);
  }

  function halt(kind: Halt) {
    halted = kind;
    busy = false;
    clearTimers();
    emit();
    settle();
    abandon(kind, HALT_MESSAGE[kind]);
  }

  function schedule() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      pump();
    }, DEBOUNCE_MS);
    maxTimer ??= setTimeout(() => {
      maxTimer = undefined;
      pump();
    }, MAX_WAIT_MS);
  }

  /**
   * A save was confirmed (or found to have landed). Clean: done. Edits made while it was out: they go on the normal
   * schedule, not at once. Sending the next save the moment the last one is answered would, during steady typing, be
   * one request per round trip: about 5 a second, past the route's 120 a minute. Only a flush() (someone is waiting)
   * or a disposed editor (nobody is looking, the page may be on its way out) cannot wait.
   */
  function afterConfirmed() {
    maybeLanded.length = 0;
    if (!isDirty()) {
      emit();
      settle();
    } else if (disposed || waiters.length > 0) pump();
    else {
      schedule();
      emit();
    }
  }

  /** Sends one save of the newest snapshot, unless one is already out or nothing is waiting. */
  function pump() {
    if (busy || halted) return;
    clearTimers();
    if (!isDirty()) {
      failure = null;
      emit();
      settle();
      return;
    }
    failure = null;
    busy = true;
    const gen = generation;
    const snapshot: Snapshot<D> = { doc: current.doc, name: current.name };
    emit();
    deps.save(saved.version, snapshot).then(
      (result) => onSaved(gen, snapshot, result.version),
      (err) => void onFailed(gen, snapshot, err),
    );
  }

  function onSaved(gen: number, snapshot: Snapshot<D>, version: number) {
    if (gen !== generation) return; // answered after reset(): about a document that is no longer tracked
    busy = false;
    failure = null;
    retryCount = 0;
    // What was confirmed is the snapshot that was SENT, not what the editor holds now: edits made while the request
    // was out are still unsaved, and go out next, on top of the version just returned.
    saved = { version, doc: snapshot.doc, name: snapshot.name };
    afterConfirmed();
  }

  async function onFailed(gen: number, snapshot: Snapshot<D>, err: unknown) {
    if (gen !== generation) return;
    const verdict = judge(err);

    if (verdict.kind === "conflict") {
      let server: Saved<D>;
      try {
        server = await deps.fetchLatest();
      } catch {
        if (gen === generation) transient("Couldn't reach the server."); // cannot tell yet what is stored: try again later
        return;
      }
      if (gen !== generation) return;
      // The server holds this snapshot, or one an earlier request carried whose answer was lost (a request that got no
      // answer may well have been stored): then nobody else wrote, and this is not a conflict. Take the server's
      // version, with the snapshot it holds as the saved one; anything newer in the editor is still unsaved and goes on.
      const landed = [snapshot, ...maybeLanded].find((s) => sameJson(server.doc, s.doc) && server.name === s.name);
      if (landed) {
        busy = false;
        failure = null;
        retryCount = 0;
        saved = { version: server.version, doc: landed.doc, name: landed.name };
        afterConfirmed();
        return;
      }
      latest = server;
      halt("conflict");
      return;
    }

    if (verdict.kind === "deleted" || verdict.kind === "archived" || verdict.kind === "forbidden" || verdict.kind === "session") {
      halt(verdict.kind);
      return;
    }
    if (verdict.kind === "rejected") {
      // The server refused this content: trying again would be refused again. The next edit tries a new snapshot.
      busy = false;
      failure = { kind: "rejected", message: verdict.message };
      emit();
      settle();
      abandon("rejected", verdict.message);
      return;
    }
    maybeLanded.push(snapshot);
    if (maybeLanded.length > RETRY_DELAYS_MS.length + 1) maybeLanded.shift();
    transient(verdict.message);
  }

  function transient(message: string) {
    busy = false;
    if (retryCount < RETRY_DELAYS_MS.length) {
      failure = { kind: "retrying", message };
      const delay = RETRY_DELAYS_MS[retryCount++];
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        pump();
      }, delay);
      emit();
      settle(); // a flush() waiting for this answers false now: the caller decides whether to wait or leave
    } else {
      failure = { kind: "failed", message };
      emit();
      settle();
      abandon("network", message);
    }
  }

  return {
    update(doc, name) {
      if (disposed) return;
      current = { doc, name };
      if (halted) {
        emit();
        return;
      }
      if (!isDirty()) {
        // Back to the saved document (undo, or an edit reverted): nothing to send.
        clearTimeout(debounceTimer);
        clearTimeout(maxTimer);
        debounceTimer = maxTimer = undefined;
        if (!busy) {
          clearTimeout(retryTimer);
          retryTimer = undefined;
          failure = null;
          retryCount = 0;
        }
        emit();
        if (!busy) settle();
        return;
      }
      if (busy || retryTimer !== undefined) {
        emit(); // a request is out (the newest goes next) or a retry is waiting (it sends the newest)
        return;
      }
      if (failure) {
        failure = null; // failed or rejected: a new edit starts over
        retryCount = 0;
      }
      schedule();
      emit();
    },

    flush() {
      if (halted) return Promise.resolve(false);
      if (!isDirty() && !busy) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        waiters.push(resolve);
        if (!busy) pump();
      });
    },

    retry() {
      if (disposed) return;
      if (halted === "session") halted = null;
      else if (halted) return;
      failure = null;
      retryCount = 0;
      pump();
    },

    reset(next) {
      if (disposed) return;
      generation++; // whatever was in flight is about the old state
      clearTimers();
      busy = false;
      halted = null;
      failure = null;
      latest = null;
      maybeLanded.length = 0;
      retryCount = 0;
      abandoned = false;
      saved = next;
      current = { doc: next.doc, name: next.name };
      emit();
      settle();
    },

    dispose() {
      if (disposed) return;
      disposed = true; // from here on nothing reaches the UI. The generation is NOT touched.
      clearTimeout(debounceTimer);
      clearTimeout(maxTimer);
      debounceTimer = maxTimer = undefined;
      if (busy) return; // its answer adopts the version and saves anything newer
      if (!isDirty()) {
        clearTimers();
        return;
      }
      if (halted) return abandon(halted, HALT_MESSAGE[halted]);
      if (failure && failure.kind !== "retrying") return abandon(failure.kind === "failed" ? "network" : "rejected", failure.message);
      if (retryTimer === undefined) pump(); // dirty and idle: send the newest now (a waiting retry carries on by itself)
    },

    get info() {
      return infoNow();
    },
    get conflict() {
      return latest;
    },
    get version() {
      return saved.version;
    },
  };
}
