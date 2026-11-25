// @vitest-environment jsdom
// The approved-design picker of Add Content: what it lists, what it draws, and what it sends. The Canvas client, the engine loader and the
// stage are stubbed (the stage exposes the real handle shape: exportImage); everything else is the real component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  upload: vi.fn(),
  getSubmission: vi.fn(),
  exportImage: vi.fn(),
  opened: null as unknown as { engine: object | null; design: { document: object; images: Map<string, unknown>; missing: string[] } | null; problem: string | null; failure: { message: string; retry: () => void } | null },
}));

vi.mock("@/lib/canvas", () => ({
  listApprovedDesigns: h.list,
  uploadDesignImage: h.upload,
  getSubmission: h.getSubmission,
  canvasProblem: (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback),
  formatWhen: (iso: string) => `on ${iso.slice(0, 10)}`,
}));
vi.mock("@/components/canvas/useCanvasBootstrap", () => ({ assetIdsOf: () => [], useOpenedDesign: () => h.opened }));
vi.mock("@/components/canvas/ReadOnlyStage", () => ({
  ReadOnlyStage: ({ stageRef }: { stageRef?: { current: unknown } }) => {
    if (stageRef) stageRef.current = { exportImage: h.exportImage, zoomBy: () => {}, fit: () => {} };
    return <div data-testid="stage" />;
  },
}));

import { ApprovedDesignPicker, DESIGN_DISCLOSURE } from "./ApprovedDesignPicker";

const D = (n: number, extra: Record<string, unknown> = {}) => ({ submissionId: `s${n}`, instanceId: `i${n}`, number: n, name: `Design ${n}`, submittedAt: "2026-11-01T10:00:00Z", approvedAt: "2026-11-02T10:00:00Z", archived: false, ...extra });
const onClose = vi.fn();
const onAttach = vi.fn();
const show = (open = true) => render(<ApprovedDesignPicker open={open} onClose={onClose} onAttach={onAttach} />);
const attachButton = () => screen.getByRole("button", { name: /Attach this design|Attaching/ }) as HTMLButtonElement;
const pick = async (name: string) => userEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));

beforeEach(() => {
  for (const f of [h.list, h.upload, h.getSubmission, h.exportImage, onClose, onAttach]) f.mockReset();
  h.opened = { engine: {}, design: { document: { schemaVersion: 1, width: 1080, height: 1350, nodes: [] }, images: new Map(), missing: [] }, problem: null, failure: null };
  h.list.mockResolvedValue({ designs: [D(3), D(1, { archived: true })], nextCursor: null });
});
afterEach(cleanup);

describe("ApprovedDesignPicker: the list", () => {
  it("lists EVERY approved version it is given (not only the latest), marks an archived design, and says what the server can and cannot check", async () => {
    show();
    expect(await screen.findByText("Design 3")).toBeTruthy();
    expect(screen.getByText("Design 1")).toBeTruthy();
    expect(screen.getByText(/Version 3 · approved on 2026-11-02/)).toBeTruthy();
    expect(screen.getByText(/Version 1 · approved on 2026-11-02/)).toBeTruthy();
    expect(screen.getAllByText("Archived")).toHaveLength(1);
    expect(screen.getByText(DESIGN_DISCLOSURE)).toBeTruthy(); // word for word
    expect(DESIGN_DISCLOSURE).toContain("It cannot check the picture itself.");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("asks for nothing while closed", () => {
    show(false);
    expect(h.list).not.toHaveBeenCalled();
  });

  it("an empty list says how a design gets here", async () => {
    h.list.mockResolvedValue({ designs: [], nextCursor: null });
    show();
    expect(await screen.findByText("No approved designs yet")).toBeTruthy();
    expect(screen.getByText(/once the design team has approved it/)).toBeTruthy();
  });

  it("a failed load says so and Try again loads it", async () => {
    h.list.mockRejectedValueOnce(new Error("offline"));
    show();
    expect(await screen.findByText("Your approved designs didn't load")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Design 3")).toBeTruthy();
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("Load more asks with the cursor the server gave, and a version never appears twice", async () => {
    h.list.mockResolvedValueOnce({ designs: [D(3)], nextCursor: "page-2" });
    h.list.mockResolvedValueOnce({ designs: [D(3), D(2)], nextCursor: null }); // a page that overlapped
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Design 2")).toBeTruthy();
    expect(h.list.mock.calls[1]).toEqual(["page-2"]);
    expect(screen.getAllByText("Design 3")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("a failed Load more keeps the list and says so", async () => {
    h.list.mockResolvedValueOnce({ designs: [D(3)], nextCursor: "page-2" });
    h.list.mockRejectedValueOnce(new Error("You are doing that too fast."));
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect((await screen.findByRole("alert")).textContent).toContain("You are doing that too fast.");
    expect(screen.getByText("Design 3")).toBeTruthy();
  });
});

describe("ApprovedDesignPicker: attaching", () => {
  it("draws the picked design at 1x, sends that picture to the server for THAT submission, and hands back what the server stored", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    h.exportImage.mockResolvedValue(png);
    h.upload.mockResolvedValue({ url: "/uploads/canvas-designs/s3/p.png", bytes: 123 });
    show();
    expect(screen.queryByTestId("stage")).toBeNull();
    expect(attachButton().disabled).toBe(true); // nothing picked yet
    await pick("Design 3");
    expect(await screen.findByTestId("stage")).toBeTruthy();
    await waitFor(() => expect(attachButton().disabled).toBe(false));
    await userEvent.click(attachButton());
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    expect(h.exportImage).toHaveBeenCalledWith({ format: "png", multiplier: 1 }); // the original size, never a thumbnail
    expect(h.upload).toHaveBeenCalledWith("s3", png);
    expect(onAttach).toHaveBeenCalledWith({ submissionId: "s3", url: "/uploads/canvas-designs/s3/p.png", bytes: 123 });
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape during the upload cannot close the dialog and mutate the post after cancellation", async () => {
    let finish!: (value: { url: string; bytes: number }) => void;
    h.exportImage.mockResolvedValue(new Blob(["png"]));
    h.upload.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    show();
    await pick("Design 3");
    await waitFor(() => expect(attachButton().disabled).toBe(false));
    await userEvent.click(attachButton());
    await waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    finish({ url: "/uploads/canvas-designs/s3/p.png", bytes: 123 });
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1); // only the success path closed it
  });

  it("a refused upload attaches NOTHING, keeps the dialog open, says why, and can be tried again", async () => {
    h.exportImage.mockResolvedValue(new Blob(["png"]));
    h.upload.mockRejectedValueOnce(new Error("That design is not an approved design of yours in this workspace."));
    show();
    await pick("Design 3");
    await waitFor(() => expect(attachButton().disabled).toBe(false));
    await userEvent.click(attachButton());
    expect((await screen.findByRole("alert")).textContent).toContain("not an approved design of yours");
    expect(onAttach).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    h.upload.mockResolvedValueOnce({ url: "/u", bytes: 1 });
    await waitFor(() => expect(attachButton().disabled).toBe(false));
    await userEvent.click(attachButton());
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
  });

  it("a picture that cannot be drawn is never uploaded", async () => {
    h.exportImage.mockRejectedValue(new Error("An image of this design is missing."));
    show();
    await pick("Design 3");
    await waitFor(() => expect(attachButton().disabled).toBe(false));
    await userEvent.click(attachButton());
    expect((await screen.findByRole("alert")).textContent).toContain("missing");
    expect(h.upload).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("cannot attach while an image of the design failed to load (the picture would have a grey box)", async () => {
    h.opened.design!.missing = ["asset-1"];
    show();
    await pick("Design 3");
    expect(await screen.findByText(/An image of this design could not be loaded/)).toBeTruthy();
    expect(attachButton().disabled).toBe(true);
  });

  it("a design that cannot be shown cannot be attached, and a load failure offers Try again", async () => {
    h.opened = { engine: null, design: null, problem: "not-found", failure: null };
    show();
    await pick("Design 3");
    expect(await screen.findByText(/can't be shown/)).toBeTruthy();
    expect(attachButton().disabled).toBe(true);
    cleanup();
    const retry = vi.fn();
    h.opened = { engine: null, design: null, problem: null, failure: { message: "The design could not be loaded.", retry } };
    show();
    await pick("Design 3");
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalled();
    expect(attachButton().disabled).toBe(true);
  });
});
