/**
 * What each way of showing a design lets the pointer do. Pure, so it is tested without a canvas (the stage itself needs a
 * browser), and CanvasStage reads every rule from here.
 *
 *  - "designer": everything (a layer is dragged, resized, rotated, selected).
 *  - "marketing": a design made from a published template. Nothing is dragged or resized; only the layers in `selectable`
 *    (the revision's manifest) react to the pointer, so a click on a locked layer goes through to the artboard.
 *  - "readonly": a submission being looked at (by the designer who reviews it, or the person who made it). Nothing reacts to
 *    the pointer at all: no selection, no handles, no editing. Zoom and pan still work, because they only move the view.
 */
export type StageMode = "designer" | "marketing" | "readonly";

export interface LayerRules {
  /** The layer can be dragged. */
  draggable: boolean;
  /** The layer receives the pointer (so it can be selected); when false a click passes through to what is beneath it. */
  listening: boolean;
}

export const layerRules = (mode: StageMode, selectable: ReadonlySet<string> | undefined, id: string): LayerRules => ({
  draggable: mode === "designer",
  listening: mode === "designer" || (mode === "marketing" && (selectable?.has(id) ?? false)),
});

export interface HandleRules {
  /** The Transformer shows resize and rotate handles. */
  handles: boolean;
  /** The Transformer is attached to a selected layer at all (its outline). */
  outline: boolean;
}

export const handleRules = (mode: StageMode): HandleRules => ({ handles: mode === "designer", outline: mode !== "readonly" });
