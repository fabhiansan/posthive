// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useOpenSnapshot } from "./useOpenSnapshot";

afterEach(cleanup);

describe("useOpenSnapshot: the subject of a dialog while it fades out", () => {
  it("is nothing while the dialog has never been opened", () => {
    const { result } = renderHook(() => useOpenSnapshot<string>(null));
    expect(result.current).toBeNull();
  });

  it("is the subject as soon as it opens (in the same render: nothing is painted without it)", () => {
    const { result, rerender } = renderHook(({ v }) => useOpenSnapshot(v), { initialProps: { v: null as string | null } });
    rerender({ v: "Case Study" });
    expect(result.current).toBe("Case Study");
  });

  it("keeps the subject after the page clears it, so the closing dialog still has its content", () => {
    const { result, rerender } = renderHook(({ v }) => useOpenSnapshot(v), { initialProps: { v: "Case Study" as string | null } });
    rerender({ v: null });
    expect(result.current).toBe("Case Study");
  });

  it("does not follow the subject while the dialog is open (a reload must not change what was asked about)", () => {
    const { result, rerender } = renderHook(({ v }) => useOpenSnapshot(v), { initialProps: { v: { status: "Published" } as { status: string } | null } });
    rerender({ v: { status: "Draft" } });
    expect(result.current).toEqual({ status: "Published" });
  });

  it("takes the next subject when the dialog opens again", () => {
    const { result, rerender } = renderHook(({ v }) => useOpenSnapshot(v), { initialProps: { v: "Case Study" as string | null } });
    rerender({ v: null });
    rerender({ v: "Blog Post" });
    expect(result.current).toBe("Blog Post");
  });
});
