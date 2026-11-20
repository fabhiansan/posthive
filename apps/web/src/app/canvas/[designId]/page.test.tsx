// @vitest-environment jsdom
// /canvas/<id> chooses its screen by role: the design team opens a template design, Marketing opens its own design made from a
// published template, anyone else sees a message. Each role's API answers 404 for the other kind of design, so an id of the wrong
// kind is "doesn't exist". The editors themselves are replaced here: this pins which screen is chosen and which API it asks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  designer: false,
  editContent: true,
  id: "abc",
  view: null as string | null, // the ?view= parameter
  getDesign: vi.fn(),
  getInstance: vi.fn(),
  listSubmissions: vi.fn(),
  // What the engine hands back once it has loaded: a stand-in, because Konva needs a real browser.
  engine: { stand: "in" } as unknown,
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ designId: h.id }), useSearchParams: () => ({ get: (k: string) => (k === "view" ? h.view : null) }) }));
vi.mock("@/lib/canvas", () => ({ listSubmissions: (...a: unknown[]) => h.listSubmissions(...a) }));
vi.mock("@/components/canvas/SubmissionHistory", () => ({
  SubmissionHistory: ({ designId }: { designId: string }) => <p>HISTORY {designId}</p>,
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/usePermissions", () => ({ usePermissions: () => ({ canManageTemplates: h.designer, canEditContent: h.editContent, loading: false }) }));
vi.mock("@/components/canvas/CanvasGate", () => ({ CanvasGate: ({ children }: { children: (d: boolean) => React.ReactNode }) => <>{children(h.designer)}</> }));
vi.mock("@/components/canvas/CanvasBoot", () => ({ useBootNone: () => {}, useBootReport: () => () => {} }));
vi.mock("@/components/canvas/CanvasEditor", () => ({ CanvasEditor: ({ design }: { design: { id: string } }) => <p>DESIGNER EDITOR {design.id}</p> }));
vi.mock("@/components/canvas/InstanceEditor", () => ({ InstanceEditor: ({ instance }: { instance: { id: string } }) => <p>MARKETING EDITOR {instance.id}</p> }));
vi.mock("@/components/canvas/useCanvasBootstrap", () => ({
  // The two loaders the page uses, over the two APIs. A 404 is a "not-found" problem, a 403 "forbidden", like the real hook.
  useCanvasBootstrap: (id: string) => bootstrap(() => h.getDesign(id)),
  instanceSource: { marker: "instance" },
  useOpenedDesign: (id: string) => bootstrap(() => h.getInstance(id)),
}));

import * as React from "react";
import CanvasDesignPage from "./page";

/** A tiny stand-in for the real hook: fetches once, and reports the same shapes the page reads. */
function bootstrap(load: () => Promise<unknown>) {
  const [state, setState] = React.useState<{ design: unknown; problem: string | null }>({ design: null, problem: null });
  React.useEffect(() => {
    let live = true;
    load().then(
      (design) => live && setState({ design, problem: null }),
      (err: { status?: number }) => live && setState({ design: null, problem: err.status === 404 ? "not-found" : err.status === 403 ? "forbidden" : null }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { engine: state.design ? h.engine : null, design: state.design, problem: state.problem, failure: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.designer = false;
  h.editContent = true;
  h.id = "abc";
  h.view = null;
  h.getDesign.mockResolvedValue({ id: "abc" });
  h.getInstance.mockResolvedValue({ id: "abc" });
  h.listSubmissions.mockRejectedValue(Object.assign(new Error("Design not found"), { status: 404 })); // no history: a design that never was submitted
});
afterEach(cleanup);

describe("/canvas/<id> chooses its screen by role", () => {
  it("the design team opens a template design in the designer editor, and never asks the Marketing API", async () => {
    h.designer = true;
    h.editContent = false;
    render(<CanvasDesignPage />);
    expect(await screen.findByText("DESIGNER EDITOR abc")).toBeTruthy();
    expect(h.getDesign).toHaveBeenCalledWith("abc");
    expect(h.getInstance).not.toHaveBeenCalled();
  });

  // The role itself is decided by usePermissions (canEditContent: owner, admin, member), which has its own tests; this file only
  // pins what the page does with that answer.
  it("a content editor opens their own design in the Marketing editor, and never asks the designer API", async () => {
    render(<CanvasDesignPage />);
    expect(await screen.findByText("MARKETING EDITOR abc")).toBeTruthy();
    expect(h.getInstance).toHaveBeenCalledWith("abc");
    expect(h.getDesign).not.toHaveBeenCalled();
  });

  it("someone who may do neither sees a message and nothing is asked", () => {
    h.editContent = false;
    render(<CanvasDesignPage />);
    expect(screen.getByText("Designs are for the design team")).toBeTruthy();
    expect(h.getDesign).not.toHaveBeenCalled();
    expect(h.getInstance).not.toHaveBeenCalled();
  });

  describe("an id of the wrong kind, in both directions, is 'doesn't exist' (each API answers 404 for the other kind)", () => {
    it("a designer opening a Marketing design's id", async () => {
      h.designer = true;
      h.getDesign.mockRejectedValue(Object.assign(new Error("Design not found"), { status: 404 }));
      render(<CanvasDesignPage />);
      expect(await screen.findByText("This design doesn't exist")).toBeTruthy();
      expect(screen.queryByText(/EDITOR/)).toBeNull();
    });

    it("a member opening a template design's id, or another person's design", async () => {
      h.getInstance.mockRejectedValue(Object.assign(new Error("Design not found"), { status: 404 }));
      render(<CanvasDesignPage />);
      expect(await screen.findByText("This design doesn't exist")).toBeTruthy();
      expect(screen.queryByText(/EDITOR/)).toBeNull();
    });
  });

  it("a refusal (403) from the API is a message of its own, not an editor", async () => {
    h.getInstance.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    render(<CanvasDesignPage />);
    expect(await screen.findByText("You can't open this design")).toBeTruthy();
    cleanup();
    h.designer = true;
    h.getDesign.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    render(<CanvasDesignPage />);
    expect(await screen.findByText("Designs are for the design team")).toBeTruthy();
  });

  describe("a design that was submitted (phase 6)", () => {
    it("?view=history opens the submission history and never loads the editor or the instance", async () => {
      h.view = "history";
      render(<CanvasDesignPage />);
      expect(await screen.findByText("HISTORY abc")).toBeTruthy();
      expect(h.getInstance).not.toHaveBeenCalled();
      expect(screen.queryByText(/EDITOR/)).toBeNull();
    });

    it("an id the editor answers 404 for, that HAS a history, is an archived design: its history (which says so itself, from the server)", async () => {
      h.getInstance.mockRejectedValue(Object.assign(new Error("This design was archived"), { status: 404 }));
      h.listSubmissions.mockResolvedValue({ submissions: [{ number: 1 }], nextCursor: null });
      render(<CanvasDesignPage />);
      expect(await screen.findByText("HISTORY abc")).toBeTruthy();
      expect(h.listSubmissions).toHaveBeenCalledWith("abc");
      expect(screen.queryByText("This design doesn't exist")).toBeNull();
    });

    it("an id that has no history either is 'doesn't exist' (another person's, a template's, or one deleted before it was ever submitted)", async () => {
      h.getInstance.mockRejectedValue(Object.assign(new Error("Design not found"), { status: 404 }));
      render(<CanvasDesignPage />);
      expect(await screen.findByText("This design doesn't exist")).toBeTruthy();
      expect(screen.queryByText(/HISTORY/)).toBeNull();
    });

    it("if the history check itself fails (not a 404) it says Canvas didn't open and Try again asks again, instead of claiming the design is gone", async () => {
      h.getInstance.mockRejectedValue(Object.assign(new Error("Design not found"), { status: 404 }));
      h.listSubmissions.mockRejectedValueOnce(Object.assign(new Error("Server error"), { status: 500 }));
      h.listSubmissions.mockResolvedValue({ submissions: [{ number: 1 }], nextCursor: null });
      render(<CanvasDesignPage />);
      expect(await screen.findByText("Canvas didn't open")).toBeTruthy();
      expect(screen.queryByText("This design doesn't exist")).toBeNull();
      screen.getByRole("button", { name: "Try again" }).click();
      expect(await screen.findByText("HISTORY abc")).toBeTruthy();
    });

    it("the designer's screen never asks the Marketing history", async () => {
      h.designer = true;
      h.editContent = false;
      h.view = "history";
      render(<CanvasDesignPage />);
      expect(await screen.findByText("DESIGNER EDITOR abc")).toBeTruthy();
      expect(h.listSubmissions).not.toHaveBeenCalled();
    });
  });

  it("moving to another id starts the screen afresh (it is keyed by the id)", async () => {
    const { rerender } = render(<CanvasDesignPage />);
    expect(await screen.findByText("MARKETING EDITOR abc")).toBeTruthy();
    h.id = "xyz";
    h.getInstance.mockResolvedValue({ id: "xyz" });
    rerender(<CanvasDesignPage />);
    expect(await screen.findByText("MARKETING EDITOR xyz")).toBeTruthy();
    expect(h.getInstance).toHaveBeenLastCalledWith("xyz");
  });
});
