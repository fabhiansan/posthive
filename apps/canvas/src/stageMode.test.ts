// What each stage mode lets the pointer do (phase 6 adds "readonly"). The stage itself needs a browser; the rules it reads are
// pure, so they are pinned here. The designer and marketing rows are what the stage did before the rules were extracted.
import { describe, expect, it } from "vitest";
import { handleRules, layerRules } from "./stageMode";

const fields = new Set(["head", "photo"]);

describe("layerRules", () => {
  it("designer: every layer is draggable and listens, whatever `selectable` says", () => {
    for (const sel of [undefined, fields, new Set<string>()]) {
      for (const id of ["head", "legal"]) expect(layerRules("designer", sel, id)).toEqual({ draggable: true, listening: true });
    }
  });

  it("marketing: nothing is draggable; only the manifest's layers listen, so a click on a locked layer passes through", () => {
    expect(layerRules("marketing", fields, "head")).toEqual({ draggable: false, listening: true });
    expect(layerRules("marketing", fields, "photo")).toEqual({ draggable: false, listening: true });
    expect(layerRules("marketing", fields, "legal")).toEqual({ draggable: false, listening: false });
    expect(layerRules("marketing", undefined, "head")).toEqual({ draggable: false, listening: false }); // no manifest: nothing to select
    expect(layerRules("marketing", new Set(), "head")).toEqual({ draggable: false, listening: false });
  });

  it("readonly: nothing is draggable and NOTHING listens, even a layer named in `selectable`", () => {
    for (const sel of [undefined, fields, new Set(["legal"])]) {
      for (const id of ["head", "photo", "legal", "unknown"]) expect(layerRules("readonly", sel, id), `${id}`).toEqual({ draggable: false, listening: false });
    }
  });

  it("an inherited name is never selectable (a Set has no prototype lookups)", () => {
    expect(layerRules("marketing", fields, "__proto__").listening).toBe(false);
    expect(layerRules("marketing", fields, "constructor").listening).toBe(false);
  });
});

describe("handleRules", () => {
  it("only the designer gets resize and rotate handles", () => {
    expect(handleRules("designer").handles).toBe(true);
    expect(handleRules("marketing").handles).toBe(false);
    expect(handleRules("readonly").handles).toBe(false);
  });

  it("designer and marketing outline the selected layer; readonly outlines nothing", () => {
    expect(handleRules("designer").outline).toBe(true);
    expect(handleRules("marketing").outline).toBe(true);
    expect(handleRules("readonly").outline).toBe(false);
  });
});
