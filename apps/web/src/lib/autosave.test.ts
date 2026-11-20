// The autosave controller, with fake timers and a request the test answers by hand. No DOM, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosave, sameJson, type AbandonReason, type AutosaveInfo, type Saved, type Snapshot } from "./autosave";

type Doc = Record<string, unknown>;
const D0: Doc = { n: 0 };
const doc = (n: number): Doc => ({ n });

const http = (status: number, error?: string) => Object.assign(new Error(error ?? `${status} error`), { status, data: { error } });
const offline = () => new TypeError("Failed to fetch");
/** Lets answered promises run their handlers. */
const settle = () => vi.advanceTimersByTimeAsync(0);

function setup(start: Saved<Doc> = { version: 1, doc: D0, name: "A" }) {
  const requests: Array<{ version: number; snapshot: Snapshot<Doc>; ok(version?: number): void; fail(err: unknown): void }> = [];
  const states: AutosaveInfo[] = [];
  const abandoned: Array<{ reason: AbandonReason; snapshot: Snapshot<Doc>; message: string }> = [];
  let server: Saved<Doc> = start;
  const save = vi.fn(
    (version: number, snapshot: Snapshot<Doc>) =>
      new Promise<{ version: number }>((resolve, reject) => {
        requests.push({ version, snapshot, ok: (v = version + 1) => resolve({ version: v }), fail: reject });
      }),
  );
  const fetchLatest = vi.fn(async () => server);
  const a = createAutosave<Doc>(
    start,
    { save, fetchLatest, onState: (info) => states.push(info), onAbandon: (reason, snapshot, message) => abandoned.push({ reason, snapshot, message }) },
  );
  return { a, save, fetchLatest, requests, states, abandoned, setServer: (s: Saved<Doc>) => (server = s) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("when a save goes out", () => {
  it("waits 1.5 s after the last of several changes, then sends only the newest", async () => {
    const { a, save } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1000);
    a.update(doc(2), "A");
    await vi.advanceTimersByTimeAsync(1000);
    a.update(doc(3), "A");
    await vi.advanceTimersByTimeAsync(1499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(1, { doc: doc(3), name: "A" });
  });

  it("never waits longer than 10 s while the person keeps changing things (saves near 10 s and 20 s)", async () => {
    const { a, save } = setup();
    const t0 = Date.now();
    const times: number[] = [];
    save.mockImplementation(async (version: number) => {
      times.push(Date.now() - t0);
      return { version: version + 1 };
    });
    a.update(doc(0), "A");
    for (let s = 1; s <= 25; s++) {
      await vi.advanceTimersByTimeAsync(1000);
      a.update(doc(s), "A"); // a change every second: the 1.5 s wait alone would never end
    }
    expect(times).toEqual([10_000, 20_000]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(times).toEqual([10_000, 20_000, 26_500]);
  });

  it("does nothing for a change that leaves the document as saved", async () => {
    const { a, save } = setup();
    a.update(D0, "A");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).not.toHaveBeenCalled();
    expect(a.info).toEqual({ state: "saved", dirty: false });
  });

  it("saves a change of the name alone, with the same document", async () => {
    const { a, save, requests } = setup();
    a.update(D0, "B");
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledWith(1, { doc: D0, name: "B" });
    requests[0].ok();
    await settle();
    expect(a.info).toEqual({ state: "saved", dirty: false });
    a.update(D0, "B");
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1); // the name is now the saved one
  });

  it("reports dirty, saving, then saved", async () => {
    const { a, requests, states } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].ok();
    await settle();
    expect(states.map((s) => s.state)).toEqual(["dirty", "saving", "saved"]);
  });
});

describe("one request at a time, and what an answer confirms", () => {
  it("starts no second request while one is out, then sends one follow-up (after the normal wait) with the newest snapshot and the returned version", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(1);
    a.update(doc(2), "A");
    await vi.advanceTimersByTimeAsync(20_000); // timers cannot start a second request
    expect(save).toHaveBeenCalledTimes(1);
    requests[0].ok(); // version 2
    await settle();
    expect(save).toHaveBeenCalledTimes(1); // not back to back: it waits like any other edit
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(2, { doc: doc(2), name: "A" });
    requests[1].ok();
    await settle();
    expect(a.info).toEqual({ state: "saved", dirty: false });
  });

  it("a response never marks newer edits as saved", async () => {
    const { a, requests } = setup();
    const first = doc(1);
    const second = doc(2);
    a.update(first, "A");
    await vi.advanceTimersByTimeAsync(1500);
    a.update(second, "A"); // edited while the first is in flight
    requests[0].ok();
    await settle();
    // the first is confirmed, the second is not: still unsaved, and waiting its turn
    expect(a.info).toMatchObject({ state: "dirty", dirty: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(a.info).toMatchObject({ state: "saving", dirty: true });
    expect(requests[1].snapshot.doc).toBe(second);
    requests[1].ok();
    await settle();
    expect(a.info).toEqual({ state: "saved", dirty: false });
  });

  it("steady typing is not one request per round trip: saves stay about 10 s apart even when every answer takes 200 ms", async () => {
    const { a, save } = setup();
    const times: number[] = [];
    const t0 = Date.now();
    save.mockImplementation(
      (version: number) =>
        new Promise<{ version: number }>((resolve) => {
          times.push(Date.now() - t0);
          setTimeout(() => resolve({ version: version + 1 }), 200);
        }),
    );
    for (let ms = 0; ms < 60_000; ms += 100) {
      a.update(doc(ms), "A"); // a change every 100 ms for a minute
      await vi.advanceTimersByTimeAsync(100);
    }
    // 120 saves a minute is the route's limit; one request per answer would have been about 250
    expect(times.length).toBeGreaterThanOrEqual(5);
    expect(times.length).toBeLessThanOrEqual(7);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(9000);
  });

  it("uses each answer's version for the next save: 1, 2, 3", async () => {
    const { a, save, requests } = setup();
    for (let i = 1; i <= 3; i++) {
      a.update(doc(i), "A");
      await vi.advanceTimersByTimeAsync(1500);
      requests[i - 1].ok();
      await settle();
    }
    expect(save.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it("a version the server returns is adopted even when it jumps", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].ok(40);
    await settle();
    a.update(doc(2), "A");
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenLastCalledWith(40, { doc: doc(2), name: "A" });
  });

  it("undoing back to the saved document is clean again and cancels the timer", async () => {
    const { a, save } = setup();
    a.update(doc(1), "A");
    expect(a.info.state).toBe("dirty");
    a.update(D0, "A"); // the very same object that is saved
    expect(a.info).toEqual({ state: "saved", dirty: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("undoing past a snapshot that is in flight saves the older document afterwards", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    a.update(D0, "A"); // back to what was saved before the request
    requests[0].ok();
    await settle();
    expect(a.info).toMatchObject({ state: "dirty", dirty: true }); // the server now holds doc(1), not D0
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(2, { doc: D0, name: "A" }); // so D0 must be sent
  });

  it("ignores the answer to a request sent before reset(), and the next save uses the new version", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    const reloaded = doc(9);
    a.reset({ version: 9, doc: reloaded, name: "Z" });
    requests[0].ok(); // arrives after the reset: about a document that is no longer tracked
    await settle();
    expect(a.info).toEqual({ state: "saved", dirty: false });
    expect(save).toHaveBeenCalledTimes(1);
    a.update(doc(10), "Z");
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenLastCalledWith(9, { doc: doc(10), name: "Z" });
    // and a stale failure is just as ignored
    const stale = requests[1];
    a.reset({ version: 12, doc: doc(12), name: "Z" });
    stale.fail(http(409));
    await settle();
    expect(a.info.state).toBe("saved");
  });
});

describe("a conflict (409)", () => {
  it("stops when the server holds something else, offers its version, and resumes after reset()", async () => {
    const { a, save, requests, setServer, fetchLatest } = setup();
    const theirs: Saved<Doc> = { version: 7, doc: doc(77), name: "A" };
    setServer(theirs);
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].fail(http(409));
    await settle();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(a.info.state).toBe("conflict");
    expect(a.conflict).toBe(theirs);

    a.update(doc(2), "A"); // more edits change nothing: nothing goes out
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(a.info.state).toBe("conflict");

    a.reset(a.conflict!);
    expect(a.info).toEqual({ state: "saved", dirty: false });
    a.update(doc(3), "A");
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenLastCalledWith(7, { doc: doc(3), name: "A" });
  });

  it("is not a conflict when the earlier request did land and only its answer was lost", async () => {
    const { a, save, requests, setServer } = setup();
    const sent: Doc = { b: { d: 3, c: 2 }, a: 1, gone: undefined };
    a.update(sent, "A");
    await vi.advanceTimersByTimeAsync(1500);
    // the server has the same content (keys in another order: jsonb reorders them), one version on
    setServer({ version: 2, doc: { a: 1, b: { c: 2, d: 3 } }, name: "A" });
    requests[0].fail(http(409));
    await settle();
    expect(a.info).toEqual({ state: "saved", dirty: false });
    expect(a.conflict).toBeNull();
    a.update(doc(5), "A");
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenLastCalledWith(2, { doc: doc(5), name: "A" });
  });

  it("saves edits made meanwhile on top of the adopted version", async () => {
    const { a, save, requests, setServer } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    a.update(doc(2), "A");
    setServer({ version: 2, doc: doc(1), name: "A" });
    requests[0].fail(http(409));
    await settle();
    expect(a.info).toMatchObject({ state: "dirty", dirty: true }); // adopted, and the newer edit waits its turn
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenLastCalledWith(2, { doc: doc(2), name: "A" });
    expect(a.info.state).toBe("saving");
  });

  describe("a request that got no answer may still have been stored", () => {
    const lost = async (kind: "network" | "502") => {
      const t = setup();
      t.a.update(doc(1), "A"); // S1
      await vi.advanceTimersByTimeAsync(1500);
      t.requests[0].fail(kind === "network" ? offline() : http(502)); // the server stored S1 as version 2; nobody heard
      await settle();
      expect(t.a.info.state).toBe("retrying");
      return t;
    };

    it.each(["network", "502"] as const)("an edit made while waiting to retry (%s) is saved on top of the stored version, with no false conflict", async (kind) => {
      const { a, save, requests, setServer } = await lost(kind);
      a.update(doc(2), "A"); // S2, made during the retry wait
      setServer({ version: 2, doc: doc(1), name: "A" }); // what the server holds: S1
      await vi.advanceTimersByTimeAsync(2000); // the retry sends S2 on version 1
      expect(save).toHaveBeenLastCalledWith(1, { doc: doc(2), name: "A" });
      requests[1].fail(http(409));
      await settle();
      expect(a.conflict).toBeNull();
      expect(a.info.state).not.toBe("conflict");
      expect(a.info).toMatchObject({ dirty: true }); // S2 is still unsaved...
      await vi.advanceTimersByTimeAsync(1500);
      expect(save).toHaveBeenLastCalledWith(2, { doc: doc(2), name: "A" }); // ...and goes out on top of S1's version
      requests[2].ok();
      await settle();
      expect(a.info).toEqual({ state: "saved", dirty: false });
    });

    it("also works for an older lost request than the one retried (two retries, two edits)", async () => {
      const { a, save, requests, setServer } = await lost("network"); // S1 lost
      a.update(doc(2), "A");
      await vi.advanceTimersByTimeAsync(2000);
      requests[1].fail(offline()); // S2 lost as well, but the server only ever stored S1
      await settle();
      a.update(doc(3), "A");
      setServer({ version: 2, doc: doc(1), name: "A" });
      await vi.advanceTimersByTimeAsync(5000); // the retry sends S3 on version 1
      requests[2].fail(http(409));
      await settle();
      expect(a.conflict).toBeNull();
      await vi.advanceTimersByTimeAsync(1500);
      expect(save).toHaveBeenLastCalledWith(2, { doc: doc(3), name: "A" });
    });

    it("is still a real conflict when the server holds something none of them sent", async () => {
      const { a, requests, setServer } = await lost("network");
      a.update(doc(2), "A");
      setServer({ version: 2, doc: doc(99), name: "A" }); // somebody else saved
      await vi.advanceTimersByTimeAsync(2000);
      requests[1].fail(http(409));
      await settle();
      expect(a.info.state).toBe("conflict");
      expect(a.conflict).toMatchObject({ version: 2, doc: doc(99) });
    });

    it("forgets lost requests once a version is confirmed, and after reset()", async () => {
      const first = await lost("network");
      first.requests.length = 0;
      await vi.advanceTimersByTimeAsync(2000);
      first.requests[0].ok(); // the retry of S1 succeeded: S1 is confirmed as version 2
      await settle();
      first.a.update(doc(2), "A");
      await vi.advanceTimersByTimeAsync(1500);
      first.setServer({ version: 3, doc: doc(1), name: "A" }); // the server somehow holds S1 again, not S2
      first.requests[1].fail(http(409));
      await settle();
      expect(first.a.info.state).toBe("conflict"); // S1 is not a maybe-landed any more

      const second = await lost("network");
      second.a.reset({ version: 5, doc: doc(50), name: "A" });
      second.a.update(doc(51), "A");
      await vi.advanceTimersByTimeAsync(1500);
      second.setServer({ version: 6, doc: doc(1), name: "A" });
      second.requests[1].fail(http(409));
      await settle();
      expect(second.a.info.state).toBe("conflict"); // S1 belonged to the discarded document
    });
  });

  it("does not treat the same document under another name as the same save", async () => {
    const { a, requests, setServer } = setup();
    a.update(doc(1), "B");
    await vi.advanceTimersByTimeAsync(1500);
    setServer({ version: 2, doc: doc(1), name: "Renamed elsewhere" });
    requests[0].fail(http(409));
    await settle();
    expect(a.info.state).toBe("conflict");
  });

  it("retries later when the server cannot even be asked what it holds", async () => {
    const { a, save, requests, fetchLatest } = setup();
    fetchLatest.mockRejectedValueOnce(offline());
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].fail(http(409));
    await settle();
    expect(a.info.state).toBe("retrying");
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe("failures", () => {
  it("a network failure retries after 2 s, 5 s and 15 s with the newest edits, then offers Retry", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].fail(offline());
    await settle();
    expect(a.info).toMatchObject({ state: "retrying", dirty: true, message: "Couldn't reach the server." });

    a.update(doc(2), "A"); // while waiting: the retry will carry this
    await vi.advanceTimersByTimeAsync(1999);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(1, { doc: doc(2), name: "A" });
    requests[1].fail(offline());
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(3);
    requests[2].fail(offline());
    await settle();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(save).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(4);
    requests[3].fail(offline());
    await settle();
    expect(a.info.state).toBe("failed");
    expect(vi.getTimerCount()).toBe(0); // no more automatic tries

    a.retry();
    expect(save).toHaveBeenCalledTimes(5);
    requests[4].ok();
    await settle();
    expect(a.info).toEqual({ state: "saved", dirty: false });
  });

  it.each([500, 502, 503, 408, 429])("a %i answer is retried like a network failure", async (status) => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].fail(http(status));
    await settle();
    expect(a.info.state).toBe("retrying");
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("success after a failure resets the retry schedule", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].fail(offline());
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    requests[1].ok();
    await settle();
    a.update(doc(2), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[2].fail(offline());
    await settle();
    await vi.advanceTimersByTimeAsync(2000); // 2 s again, not 5 s
    expect(save).toHaveBeenCalledTimes(4);
  });

  it("a 413 is refused for good with its own message and no retry; the next edit sends a new snapshot", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].fail(http(413, "FastifyError"));
    await settle();
    expect(a.info).toMatchObject({ state: "rejected", dirty: true, message: "This design is too large to save." });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    a.update(doc(2), "A");
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(1, { doc: doc(2), name: "A" });
  });

  it("a 400 shows the server's message and is not retried", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].fail(http(400, "document.nodes.0.width: Number must be less than or equal to 20000"));
    await settle();
    expect(a.info).toMatchObject({ state: "rejected", message: "document.nodes.0.width: Number must be less than or equal to 20000" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, "deleted"],
    [403, "forbidden"],
    [401, "session"],
  ] as const)("a %i stops autosave as %s, whatever is edited afterwards", async (status, state) => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].fail(http(status));
    await settle();
    expect(a.info).toMatchObject({ state, dirty: true });
    a.update(doc(2), "A");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Phase 6: a 404 is "deleted" unless the server says DESIGN_ARCHIVED (the design is there, but frozen: its answer is a 404 with a code).
  it("a 404 with the code DESIGN_ARCHIVED stops autosave as archived, not deleted, and says so in words", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].fail(Object.assign(new Error("archived"), { status: 404, data: { error: "This design was archived", code: "DESIGN_ARCHIVED" } }));
    await settle();
    expect(a.info).toMatchObject({ state: "archived", dirty: true, message: "This design was archived." });
    a.update(doc(2), "A");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1); // frozen: nothing more is sent
    expect(vi.getTimerCount()).toBe(0);
  });

  it("any other 404 body, or none, is still 'deleted'", async () => {
    for (const data of [undefined, {}, { code: "SOMETHING_ELSE" }, { error: "Design not found" }]) {
      const { a, requests } = setup();
      a.update(doc(1), "A");
      await vi.advanceTimersByTimeAsync(1500);
      requests[0].fail(Object.assign(new Error("gone"), { status: 404, data }));
      await settle();
      expect(a.info.state, JSON.stringify(data)).toBe("deleted");
    }
  });

  it("a 404 DESIGN_ARCHIVED in the drain (the editor already left) is reported as archived", async () => {
    const { a, requests, abandoned } = setup();
    a.update(doc(1), "A");
    a.dispose();
    requests[0].fail(Object.assign(new Error("archived"), { status: 404, data: { code: "DESIGN_ARCHIVED" } }));
    await settle();
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({ reason: "archived", snapshot: { doc: doc(1), name: "A" } });
  });

  it("after a 401 the person can retry once signed in again", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].fail(http(401));
    await settle();
    a.retry();
    expect(save).toHaveBeenCalledTimes(2);
    requests[1].ok();
    await settle();
    expect(a.info.state).toBe("saved");
    // a deleted design cannot be retried
    a.update(doc(2), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[2].fail(http(404));
    await settle();
    a.retry();
    expect(save).toHaveBeenCalledTimes(3);
  });
});

describe("flush()", () => {
  it("saves at once and resolves true when it is saved", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    const done = a.flush();
    expect(save).toHaveBeenCalledTimes(1); // no waiting for the timer
    requests[0].ok();
    await expect(done).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves true without a request when nothing is waiting", async () => {
    const { a, save } = setup();
    await expect(a.flush()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("waits for a request in flight and for the follow-up it triggers", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    a.update(doc(2), "A");
    let result: boolean | undefined;
    void a.flush().then((r) => (result = r));
    requests[0].ok();
    await settle();
    expect(result).toBeUndefined(); // the follow-up is still out
    expect(save).toHaveBeenCalledTimes(2);
    requests[1].ok();
    await settle();
    expect(result).toBe(true);
  });

  it("resolves false on a failure, a conflict, and while stopped", async () => {
    const failing = setup();
    failing.a.update(doc(1), "A");
    const failed = failing.a.flush();
    failing.requests[0].fail(offline());
    await expect(failed).resolves.toBe(false);

    const conflicting = setup();
    conflicting.setServer({ version: 4, doc: doc(44), name: "A" });
    conflicting.a.update(doc(1), "A");
    const conflicted = conflicting.a.flush();
    conflicting.requests[0].fail(http(409));
    await expect(conflicted).resolves.toBe(false);
    await expect(conflicting.a.flush()).resolves.toBe(false); // still stopped

    const refused = setup();
    refused.a.update(doc(1), "A");
    const rejected = refused.a.flush();
    refused.requests[0].fail(http(400, "no"));
    await expect(rejected).resolves.toBe(false);
  });
});

describe("dispose(): the editor is gone, the saves are not lost", () => {
  it("does NOT invalidate an answer in flight (the contrast with reset): its version is adopted and the newer edit goes out", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    a.update(doc(2), "A");
    a.dispose();
    requests[0].ok(); // version 2
    await settle();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(2, { doc: doc(2), name: "A" });
  });

  it("reset() does the opposite: the same sequence drops the answer and sends nothing more", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    a.update(doc(2), "A");
    a.reset({ version: 5, doc: doc(5), name: "A" });
    requests[0].ok();
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(a.info).toEqual({ state: "saved", dirty: false });
  });

  it("reset() after dispose() is ignored", async () => {
    const { a, save } = setup();
    a.dispose();
    a.reset({ version: 5, doc: doc(5), name: "A" });
    a.update(doc(6), "A");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).not.toHaveBeenCalled();
  });

  it("dirty with a debounce still pending: one immediate save of the newest snapshot, with the saved version", async () => {
    const { a, save, requests } = setup();
    a.update(doc(1), "A");
    a.update(doc(2), "A");
    a.dispose();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(1, { doc: doc(2), name: "A" });
    requests[0].ok();
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clean and idle: no request and no timers", async () => {
    const { a, save } = setup();
    a.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a request in flight with nothing newer: no extra request; the answer is adopted silently", async () => {
    const { a, save, requests, abandoned } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    a.dispose();
    requests[0].ok();
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(abandoned).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a request in flight and newer edits: the first finishes, then exactly one more at the next version, then nothing (1, 2, 3)", async () => {
    const { a, save, requests, abandoned } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    a.update(doc(2), "A");
    a.update(doc(3), "A");
    a.dispose();
    expect(save).toHaveBeenCalledTimes(1);
    requests[0].ok();
    await settle();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(save).toHaveBeenLastCalledWith(2, { doc: doc(3), name: "A" });
    requests[1].ok();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(abandoned).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores changes made after it", async () => {
    const { a, save } = setup();
    a.dispose();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never calls the state callback after it, however the drain ends", async () => {
    const { a, requests, states } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    a.update(doc(2), "A");
    a.dispose();
    const frozen = states.length;
    requests[0].ok();
    await settle();
    requests[1].fail(offline());
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states).toHaveLength(frozen);
  });

  it("a drain that keeps failing retries at 2 s, 5 s, 15 s, then reports the dirty snapshot once, and leaves no timer", async () => {
    const { a, save, requests, abandoned } = setup();
    a.update(doc(1), "A");
    a.dispose(); // dirty, idle: sends at once
    requests[0].fail(offline());
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    requests[1].fail(offline());
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    requests[2].fail(offline());
    await settle();
    expect(abandoned).toEqual([]);
    await vi.advanceTimersByTimeAsync(15_000);
    requests[3].fail(offline());
    await settle();
    expect(save).toHaveBeenCalledTimes(4);
    expect(abandoned).toEqual([{ reason: "network", snapshot: { doc: doc(1), name: "A" }, message: "Couldn't reach the server." }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(4); // no loop
    expect(abandoned).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a retry already waiting carries on after it", async () => {
    const { a, save, requests, abandoned } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].fail(offline());
    await settle();
    a.update(doc(2), "A");
    a.dispose(); // a retry is waiting: it will send the newest
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenLastCalledWith(1, { doc: doc(2), name: "A" });
    requests[1].ok();
    await settle();
    expect(abandoned).toEqual([]);
  });

  it("a conflict in the drain is reported when the server holds something else, and adopted when it holds the same", async () => {
    const differs = setup();
    differs.setServer({ version: 6, doc: doc(66), name: "A" });
    differs.a.update(doc(1), "A");
    differs.a.dispose();
    differs.requests[0].fail(http(409));
    await settle();
    expect(differs.abandoned).toEqual([{ reason: "conflict", snapshot: { doc: doc(1), name: "A" }, message: "This design was changed somewhere else." }]);

    const same = setup();
    same.setServer({ version: 2, doc: doc(1), name: "A" });
    same.a.update(doc(1), "A");
    same.a.dispose();
    same.requests[0].fail(http(409));
    await settle();
    expect(same.abandoned).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [400, "rejected"],
    [413, "rejected"],
    [403, "forbidden"],
    [404, "deleted"],
    [401, "session"],
  ] as const)("a %i in the drain is reported as %s, never swallowed", async (status, reason) => {
    const { a, requests, abandoned } = setup();
    a.update(doc(1), "A");
    a.dispose();
    requests[0].fail(http(status, "refused"));
    await settle();
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({ reason, snapshot: { doc: doc(1), name: "A" } });
  });

  it("disposing while already failed or stopped reports at once, and only once", async () => {
    const stopped = setup();
    stopped.a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    stopped.requests[0].fail(http(404));
    await settle();
    stopped.a.dispose();
    stopped.a.dispose();
    expect(stopped.abandoned.map((x) => x.reason)).toEqual(["deleted"]);

    const refused = setup();
    refused.a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    refused.requests[0].fail(http(400, "no"));
    await settle();
    refused.a.dispose();
    expect(refused.abandoned.map((x) => x.reason)).toEqual(["rejected"]);
  });

  it("reports nothing when everything was saved, or when the unsaved change was undone", async () => {
    const saved = setup();
    saved.a.update(doc(1), "A");
    saved.a.dispose();
    saved.requests[0].ok();
    await settle();
    expect(saved.abandoned).toEqual([]);

    const undone = setup();
    undone.a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    undone.requests[0].fail(http(400, "no"));
    await settle();
    undone.a.update(D0, "A"); // back to the saved document: nothing to lose
    undone.a.dispose();
    expect(undone.abandoned).toEqual([]);
  });
});

describe("sameJson", () => {
  it.each([
    [{ a: 1, b: 2 }, { b: 2, a: 1 }, true],
    [{ a: { x: [1, { y: 2 }] } }, { a: { x: [1, { y: 2 }] } }, true],
    [{ a: 1, gone: undefined }, { a: 1 }, true],
    [{ a: 0 }, { a: -0 }, true],
    [{ a: 1 }, { a: 2 }, false],
    [{ a: 1 }, { a: 1, b: 2 }, false],
    [{ a: 1, b: undefined }, { a: 1, b: null }, false],
    [[1, 2], [2, 1], false],
    [[1], { 0: 1 }, false],
    [null, {}, false],
    ["x", "x", true],
  ])("%j vs %j is %s", (a, b, expected) => {
    expect(sameJson(a, b)).toBe(expected);
  });
});

describe("the confirmed version (a publish names it)", () => {
  it("starts as the version the design was opened at", () => {
    const { a } = setup({ version: 7, doc: D0, name: "A" });
    expect(a.version).toBe(7);
  });

  it("is the version the server confirmed, not the one a save was sent on", async () => {
    const { a, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    expect(requests[0].version).toBe(1);
    expect(a.version).toBe(1); // sent, not confirmed yet: still the old one
    requests[0].ok(2);
    await settle();
    expect(a.version).toBe(2);
  });

  it("follows each answer (1, 2, 3) and a jump the server makes", async () => {
    const { a, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].ok(2);
    await settle();
    a.update(doc(2), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[1].ok(9);
    await settle();
    expect(a.version).toBe(9);
  });

  it("a failed save does not move it", async () => {
    const { a, requests } = setup();
    a.update(doc(1), "A");
    await vi.advanceTimersByTimeAsync(1500);
    requests[0].fail(http(400, "no"));
    await settle();
    expect(a.version).toBe(1);
  });

  it("after Reload latest (reset) it is the server's version", async () => {
    const { a } = setup();
    a.reset({ version: 12, doc: doc(5), name: "B" });
    expect(a.version).toBe(12);
  });

  it("after flush() resolves true, it is the version the last save confirmed", async () => {
    const { a, requests } = setup();
    a.update(doc(1), "A");
    const done = a.flush();
    await settle();
    requests[0].ok(2);
    await expect(done).resolves.toBe(true);
    expect(a.version).toBe(2);
  });
});
