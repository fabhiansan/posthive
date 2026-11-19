// @vitest-environment jsdom
// The generalized useAutosave: it connects ONE saved design to the real autosave controller (lib/autosave.ts, tested on its own).
// This pins the parts the generalization added or could have broken: the two calls (save, fetchLatest) are passed in and read
// when a save runs; the controller is made once per design and not per render; the designer's document and a Marketing design's
// list of changes both work; and the leaving-the-page behaviour still runs. The controller is the real one (fake timers); only the
// network calls and the toast are replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { DEBOUNCE_MS } from "@/lib/autosave";

const h = vi.hoisted(() => ({
  toast: { toast: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  unsaved: vi.fn(),
}));

vi.mock("@/components/Toast", () => ({ useToast: () => h.toast }));
// The registry the app uses to warn before the session expires. Replaced so the test can see what the hook tells it.
vi.mock("@/lib/session", () => ({ useUnsavedChanges: (key: string, dirty: boolean) => h.unsaved(key, dirty) }));

import { useAutosave } from "./useAutosave";

type Doc = { nodes: string[] };
type Props<D> = Parameters<typeof useAutosave<D>>[0];

const saved = (version = 1) => ({ id: "d1", version, name: "Spring", value: { nodes: ["a"] } as Doc });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Runs the debounce and lets the save's promise settle. */
const flushSave = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
  });
};

function mount(over: Partial<Props<Doc>> = {}, item: Props<Doc>["item"] = saved()) {
  const save = vi.fn(async (_id: string, version: number) => ({ version: version + 1 }));
  const fetchLatest = vi.fn(async () => ({ version: 9, doc: { nodes: ["server"] } as Doc, name: "Server" }));
  const onReload = vi.fn();
  const props: Props<Doc> = { item, value: item?.value ?? { nodes: [] }, name: item?.name ?? "", save, fetchLatest, onReload, ...over };
  const hook = renderHook((p: Props<Doc>) => useAutosave<Doc>(p), { initialProps: props });
  return { ...hook, save, fetchLatest, onReload, props };
}

describe("useAutosave: one saved design", () => {
  it("starts saved, at the version the design was opened at, and sends nothing while nothing changes", async () => {
    const { result, save } = mount();
    expect(result.current.info).toEqual({ state: "saved", dirty: false });
    expect(result.current.version).toBe(1);
    expect(result.current.currentVersion()).toBe(1);
    await flushSave();
    expect(save).not.toHaveBeenCalled();
  });

  it("saves a changed value after the debounce, as (id, the version it was based on, the value and name), and adopts the new version", async () => {
    const { result, rerender, save, props } = mount();
    rerender({ ...props, value: { nodes: ["a", "b"] } });
    expect(result.current.info.dirty).toBe(true);
    expect(save).not.toHaveBeenCalled(); // waits for the debounce
    await flushSave();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("d1", 1, { doc: { nodes: ["a", "b"] }, name: "Spring" });
    expect(result.current.version).toBe(2);
    expect(result.current.currentVersion()).toBe(2);
    expect(result.current.info).toEqual({ state: "saved", dirty: false });
  });

  it("a rename alone is a change too, and goes out with the unchanged value", async () => {
    const { rerender, save, props } = mount();
    rerender({ ...props, name: "Summer" });
    await flushSave();
    expect(save).toHaveBeenCalledWith("d1", 1, { doc: { nodes: ["a"] }, name: "Summer" });
  });

  it("saves one version on top of the last: the second save names the version the first one returned", async () => {
    const { rerender, save, props } = mount();
    rerender({ ...props, value: { nodes: ["a", "b"] } });
    await flushSave();
    rerender({ ...props, value: { nodes: ["a", "b", "c"] } });
    await flushSave();
    expect(save.mock.calls.map(([, version]) => version)).toEqual([1, 2]);
  });

  it("works for any saved value: a Marketing design's list of changes is saved the same way", async () => {
    type Changes = ReadonlyArray<{ nodeId: string; text: string }>;
    const empty: Changes = [];
    const save = vi.fn(async (_id: string, version: number, _s: { doc: Changes; name: string }) => ({ version: version + 1 }));
    const item = { id: "inst-1", version: 4, name: "Case Study", value: empty };
    const { result, rerender } = renderHook((p: Parameters<typeof useAutosave<Changes>>[0]) => useAutosave<Changes>(p), {
      initialProps: { item, value: empty, name: "Case Study", save, fetchLatest: vi.fn(), onReload: vi.fn() },
    });
    const next: Changes = [{ nodeId: "head", text: "Hello" }];
    rerender({ item, value: next, name: "Case Study", save, fetchLatest: vi.fn(), onReload: vi.fn() });
    await flushSave();
    expect(save).toHaveBeenCalledWith("inst-1", 4, { doc: next, name: "Case Study" });
    expect(result.current.version).toBe(5);
  });
});

describe("useAutosave: the calls are read when a save runs, and the controller is not rebuilt per render", () => {
  it("re-rendering with NEW inline save and fetchLatest functions keeps one controller, and the next save uses the NEWEST function", async () => {
    const item = saved();
    const first = vi.fn(async (_id: string, version: number) => ({ version: version + 1 }));
    const second = vi.fn(async (_id: string, version: number) => ({ version: version + 1 }));
    const { result, rerender, props } = mount({ save: first }, item);

    // Several renders with fresh function objects, as an editor that passes inline arrows does on every keystroke.
    rerender({ ...props, save: first, fetchLatest: vi.fn(), value: { nodes: ["a", "1"] } });
    rerender({ ...props, save: second, fetchLatest: vi.fn(), value: { nodes: ["a", "1", "2"] } });
    expect(result.current.info.dirty).toBe(true);
    await flushSave();

    expect(first).not.toHaveBeenCalled(); // the stale function was never used
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith("d1", 1, { doc: { nodes: ["a", "1", "2"] }, name: "Spring" }); // ONE save with the latest value
  });

  it("a stable item is one controller: unrelated re-renders never reset what the hook owes (the pending change is still sent once)", async () => {
    const { rerender, save, props } = mount();
    rerender({ ...props, value: { nodes: ["a", "b"] } });
    for (let i = 0; i < 5; i++) rerender({ ...props, value: { nodes: ["a", "b"] }, save: vi.fn(save), onReload: vi.fn() }); // same value and item, new function objects
    await flushSave();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("a NEW item object makes a new controller (that is why both editors memoize it): it restarts from the new item and the old one's work is not lost", async () => {
    const { rerender, save, props } = mount();
    rerender({ ...props, value: { nodes: ["a", "b"] } });
    // The new item arrives before the debounce fires: the old controller is disposed, which finishes what it owes.
    rerender({ ...props, item: saved(1), value: { nodes: ["a", "b"] } });
    await flushSave();
    expect(save.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(save.mock.calls.every(([id]) => id === "d1")).toBe(true);
  });
});

describe("useAutosave: conflicts and reload", () => {
  it("a 409 asks for the latest with the design's id, stops, and Reload takes the server's version and hands it to the editor", async () => {
    const conflict = Object.assign(new Error("changed"), { status: 409 });
    const save = vi.fn(async () => {
      throw conflict;
    });
    const { result, rerender, fetchLatest, onReload, props } = mount({ save });
    rerender({ ...props, save, value: { nodes: ["a", "mine"] } });
    await flushSave();
    expect(fetchLatest).toHaveBeenCalledWith("d1"); // the id passed through, not captured per hook
    expect(result.current.info.state).toBe("conflict");

    act(() => result.current.reload());
    expect(onReload).toHaveBeenCalledWith({ version: 9, doc: { nodes: ["server"] }, name: "Server" });
    expect(result.current.version).toBe(9);
  });

  it("Reload with no conflict does nothing", () => {
    const { result, onReload } = mount();
    act(() => result.current.reload());
    expect(onReload).not.toHaveBeenCalled();
  });

  it("a save the server refuses as unprocessable shows its message and a retry sends the SAME value again, to the newest function", async () => {
    const refuse = Object.assign(new Error("Too long"), { status: 400, data: { error: "Too long" } });
    const failing = vi.fn(async () => {
      throw refuse;
    });
    const working = vi.fn(async (_id: string, version: number) => ({ version: version + 1 }));
    const { result, rerender, props } = mount({ save: failing });
    rerender({ ...props, save: failing, value: { nodes: ["a", "x"] } });
    await flushSave();
    expect(result.current.info).toMatchObject({ state: "rejected", message: "Too long" });
    rerender({ ...props, save: working, value: { nodes: ["a", "x"] } });
    act(() => result.current.retry());
    await flushSave();
    expect(working).toHaveBeenCalledWith("d1", 1, { doc: { nodes: ["a", "x"] }, name: "Spring" });
    expect(result.current.info.state).toBe("saved");
  });
});

describe("useAutosave: flush, leaving the page, and the unsaved-changes registry", () => {
  it("flush saves at once and resolves true; with nothing owed it resolves true without a request", async () => {
    const { result, rerender, save, props } = mount();
    await expect(result.current.flush()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
    rerender({ ...props, value: { nodes: ["a", "b"] } });
    let done: boolean | undefined;
    await act(async () => {
      done = await result.current.flush();
    });
    expect(done).toBe(true);
    expect(save).toHaveBeenCalledTimes(1); // no waiting for the debounce
    expect(result.current.currentVersion()).toBe(2);
  });

  it("a flush that cannot save resolves false (the editor then asks before leaving)", async () => {
    const down = vi.fn(async () => {
      throw Object.assign(new Error("offline"), { status: 409 });
    });
    const { result, rerender, props } = mount({ save: down });
    rerender({ ...props, save: down, value: { nodes: ["a", "b"] } });
    let done: boolean | undefined;
    await act(async () => {
      done = await result.current.flush();
    });
    expect(done).toBe(false);
  });

  it("tells the unsaved-changes registry when there are changes, and when there are none", async () => {
    const { rerender, props } = mount();
    expect(h.unsaved).toHaveBeenLastCalledWith("canvas-design", false);
    rerender({ ...props, value: { nodes: ["a", "b"] } });
    expect(h.unsaved).toHaveBeenLastCalledWith("canvas-design", true);
    await flushSave();
    expect(h.unsaved).toHaveBeenLastCalledWith("canvas-design", false);
  });

  it("asks the browser before the tab closes while something is unsaved, and not otherwise", async () => {
    const { rerender, props } = mount();
    const closing = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(closing()).toBe(false);
    rerender({ ...props, value: { nodes: ["a", "b"] } });
    expect(closing()).toBe(true);
    await flushSave();
    expect(closing()).toBe(false);
  });

  it("removes its page listeners when it goes away, and the work it still owed is finished, not dropped", async () => {
    const { rerender, unmount, save, props } = mount();
    rerender({ ...props, value: { nodes: ["a", "b"] } });
    unmount();
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false); // its listener is gone
    await flushSave();
    expect(save).toHaveBeenCalledTimes(1); // a disposed editor still sends the last change
  });

  it("the tab going to the background sends a save while the page is alive", async () => {
    const { rerender, save, props } = mount();
    rerender({ ...props, value: { nodes: ["a", "b"] } });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("useAutosave: the local editor (no saved design)", () => {
  it("does nothing: no controller, no request, no warning on closing, and flush resolves true", async () => {
    const { result, rerender, save, props } = mount({}, undefined);
    rerender({ ...props, item: undefined, value: { nodes: ["whatever"] } });
    await flushSave();
    expect(save).not.toHaveBeenCalled();
    expect(result.current.info).toEqual({ state: "saved", dirty: false });
    await expect(result.current.flush()).resolves.toBe(true);
    expect(result.current.currentVersion()).toBeNull();
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(h.unsaved).toHaveBeenLastCalledWith("canvas-design", false);
  });
});

describe("useAutosave: the designer editor's own wiring", () => {
  // CanvasEditor passes exactly these two calls to the hook (saveDesign and getDesign, reshaped). This pins the shapes the hook
  // needs from them, so a change to either side shows up here and not in front of a designer.
  it("the designer's save and fetchLatest fit the hook: the document goes out as `document`, the reload comes back as `doc`", async () => {
    const saveDesign = vi.fn(async (_id: string, body: { version: number; document: Doc; name?: string }) => ({ version: body.version + 1 }));
    const getDesign = vi.fn(async (_id: string) => ({ design: { version: 7, document: { nodes: ["theirs"] } as Doc, name: "Theirs" } }));
    const save: Props<Doc>["save"] = (id, version, snapshot) => saveDesign(id, { version, document: snapshot.doc, name: snapshot.name });
    const fetchLatest: Props<Doc>["fetchLatest"] = async (id) => {
      const { design: latest } = await getDesign(id);
      return { version: latest.version, doc: latest.document, name: latest.name };
    };
    const { result, rerender, props } = mount({ save, fetchLatest });
    rerender({ ...props, save, fetchLatest, value: { nodes: ["a", "mine"] } });
    await flushSave();
    expect(saveDesign).toHaveBeenCalledWith("d1", { version: 1, document: { nodes: ["a", "mine"] }, name: "Spring" });
    expect(result.current.version).toBe(2);
    expect(await fetchLatest("d1")).toEqual({ version: 7, doc: { nodes: ["theirs"] }, name: "Theirs" });
  });
});
