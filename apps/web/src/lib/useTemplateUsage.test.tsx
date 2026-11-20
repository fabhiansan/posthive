// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("./api", () => ({ apiFetch: h.apiFetch }));

import { useTemplateUsage } from "./useTemplateUsage";

beforeEach(() => {
  vi.clearAllMocks();
  h.apiFetch.mockResolvedValue({ created: 12, inReview: 3 });
});
afterEach(cleanup);

describe("useTemplateUsage: the counts a dialog names", () => {
  it("asks nothing while the dialog is closed, and has no numbers", () => {
    const { result } = renderHook(() => useTemplateUsage("t1", false));
    expect(result.current).toBeNull();
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("asks for this template's counts when it opens", async () => {
    const { result } = renderHook(() => useTemplateUsage("t1", true));
    expect(result.current).toBeNull(); // not known yet: nothing is claimed
    await waitFor(() => expect(result.current).toEqual({ created: 12, inReview: 3 }));
    expect(h.apiFetch).toHaveBeenCalledWith("/templates/t1/usage");
  });

  it("keeps them while the dialog fades out (it must not change shape as it closes), and starts from nothing when it opens again", async () => {
    let finish!: (v: unknown) => void;
    const { result, rerender } = renderHook(({ open }) => useTemplateUsage("t1", open), { initialProps: { open: true } });
    await waitFor(() => expect(result.current).toEqual({ created: 12, inReview: 3 }));
    rerender({ open: false });
    expect(result.current).toEqual({ created: 12, inReview: 3 });
    // the next opening never shows these numbers: they are gone in the very render that opens it, before the answer is here
    h.apiFetch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    rerender({ open: true });
    expect(result.current).toBeNull();
    await act(async () => { finish({ created: 1, inReview: 0 }); });
    expect(result.current).toEqual({ created: 1, inReview: 0 });
  });

  it("asks nothing without a template", () => {
    renderHook(() => useTemplateUsage(undefined, true));
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("a failed request is no numbers at all, not zeroes: also after an earlier answer for another template", async () => {
    // t1 answers, then t2's request fails: if a failure were turned into zeroes, "0 posts" would be read as a fact about t2
    const { result, rerender } = renderHook(({ id }) => useTemplateUsage(id, true), { initialProps: { id: "t1" } });
    await waitFor(() => expect(result.current).toEqual({ created: 12, inReview: 3 }));
    let fail!: (e: Error) => void;
    h.apiFetch.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    rerender({ id: "t2" });
    await act(async () => { fail(new Error("boom")); });
    // the failed answer was handled (not the old numbers kept, not zeroes made up): there is nothing to say about t2
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith("/templates/t2/usage"));
    expect(result.current).toBeNull();
    expect(result.current).not.toEqual({ created: 0, inReview: 0 });
  });

  it("a request that fails on its first try is no numbers either", async () => {
    h.apiFetch.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useTemplateUsage("t1", true));
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current).toBeNull();
  });

  it("an answer that is not a number counts as zero rather than as 'NaN posts'", async () => {
    h.apiFetch.mockResolvedValue({ created: "x" });
    const { result } = renderHook(() => useTemplateUsage("t1", true));
    await waitFor(() => expect(result.current).toEqual({ created: 0, inReview: 0 }));
  });

  it("an answer that arrives after the dialog moved to another template is ignored", async () => {
    let finish!: (v: unknown) => void;
    h.apiFetch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ id }) => useTemplateUsage(id, true), { initialProps: { id: "t1" } });
    h.apiFetch.mockResolvedValueOnce({ created: 1, inReview: 1 });
    rerender({ id: "t2" });
    await waitFor(() => expect(result.current).toEqual({ created: 1, inReview: 1 }));
    await act(async () => { finish({ created: 99, inReview: 99 }); }); // the first template's late answer
    expect(result.current).toEqual({ created: 1, inReview: 1 });
  });

  it("an answer that arrives after the dialog closed is ignored: the next opening does not start from it", async () => {
    let finish!: (v: unknown) => void;
    h.apiFetch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ open }) => useTemplateUsage("t1", open), { initialProps: { open: true } });
    rerender({ open: false });
    await act(async () => { finish({ created: 99, inReview: 99 }); });
    expect(result.current).toBeNull();
    // and the next opening is empty until ITS answer comes
    h.apiFetch.mockReturnValueOnce(new Promise(() => {}));
    rerender({ open: true });
    expect(result.current).toBeNull();
  });
});
