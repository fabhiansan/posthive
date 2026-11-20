// @vitest-environment jsdom
// The read-only stage on a review. Regression: opening a review crashed with "Maximum update depth exceeded". The stage kept the
// engine's handle in useState and gave the setter to CanvasStage as its ref; CanvasStage makes a NEW handle on every render, so every
// commit set state, which re-rendered the stage, which made another handle, and so on. The handle must live in a ref object.
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as realEngine from "posthive-canvas";
import { createDocument } from "posthive-canvas";
import type { CanvasStageHandle } from "posthive-canvas";
import type { CanvasEngine } from "./useCanvasBootstrap";
import { ReadOnlyStage } from "./ReadOnlyStage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks(); // the console.error spies below, even when an assertion fails first
});

// A stand-in engine with the REAL contract: CanvasStage returns a fresh imperative handle on every render (no dependency array),
// exactly as apps/canvas/src/CanvasStage.tsx does, so the zoom and fit it closes over are never stale.
const zoomBy = vi.fn();
const fit = vi.fn();
let stageRenders = 0;
function FakeStage({ ref }: { ref?: React.Ref<CanvasStageHandle> }) {
  stageRenders++;
  React.useImperativeHandle(ref, () => ({ zoomBy, fit, exportImage: () => Promise.reject(new Error("not used")) }));
  return <div data-testid="stage" />;
}
const engine = { CanvasStage: FakeStage } as unknown as CanvasEngine;

const doc = createDocument();
const images = new Map<string, HTMLImageElement>();

describe("ReadOnlyStage with the real engine (Konva runs in jsdom)", () => {
  it("opens without a state update loop, and zoom out, fit and zoom in work through the real handle", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<ReadOnlyStage engine={realEngine as unknown as CanvasEngine} doc={doc} images={images} />)).not.toThrow();
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    await userEvent.click(screen.getByRole("button", { name: "Fit to screen" }));
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/Maximum update depth/);
  });
});

describe("ReadOnlyStage", () => {
  it("mounts and settles: the stage renders once, with no state update loop", () => {
    stageRenders = 0;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<ReadOnlyStage engine={engine} doc={doc} images={images} />)).not.toThrow();
    expect(screen.getByTestId("stage")).toBeTruthy();
    expect(stageRenders).toBe(1);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/Maximum update depth/);
  });

  it("re-rendering with a different design (the next review) does not loop either", () => {
    stageRenders = 0;
    const { rerender } = render(<ReadOnlyStage engine={engine} doc={doc} images={images} />);
    rerender(<ReadOnlyStage engine={engine} doc={{ ...doc, width: 500 }} images={images} />);
    rerender(<ReadOnlyStage engine={engine} doc={{ ...doc, width: 600 }} images={images} />);
    expect(stageRenders).toBe(3);
  });

  it("zoom out, fit and zoom in reach the engine's handle, and a click renders nothing extra", async () => {
    stageRenders = 0;
    zoomBy.mockClear();
    fit.mockClear();
    render(<ReadOnlyStage engine={engine} doc={doc} images={images} />);
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    await userEvent.click(screen.getByRole("button", { name: "Fit to screen" }));
    expect(zoomBy.mock.calls.map(([f]) => f)).toEqual([1.25, 1 / 1.25]);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(stageRenders).toBe(1);
  });
});
