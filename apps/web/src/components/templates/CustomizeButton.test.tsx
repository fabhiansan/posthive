// @vitest-environment jsdom
// The button that starts a Marketing design from a published template. The network and the router are the mocked pieces.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  push: vi.fn(),
  toast: { toast: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u, API_BASE: "http://localhost:3001" }));
vi.mock("@/components/Toast", () => ({ useToast: () => h.toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));

import { CustomizeButton } from "./CustomizeButton";

const TEMPLATE = { id: "tpl-1", category: "Case Study" };
const made = { instance: { id: "inst-1", name: "Case Study", version: 1, createdAt: "2026-11-18T00:00:00Z", baseRevision: { number: 2, createdAt: "2026-11-18T00:00:00Z" } } };

beforeEach(() => {
  vi.clearAllMocks();
  h.apiFetch.mockResolvedValue(made);
});
afterEach(cleanup);

describe("CustomizeButton", () => {
  it("is named after the template, so a list of them is not a row of identical buttons", () => {
    render(<CustomizeButton template={TEMPLATE} />);
    expect(screen.getByRole("button", { name: "Customize in Canvas: Case Study" })).toBeTruthy();
    cleanup();
    render(<CustomizeButton template={TEMPLATE} label="Customize" />);
    expect(screen.getByRole("button", { name: "Customize: Case Study" })).toBeTruthy();
  });

  it("asks the server for a design from this template, naming ONLY the template, and opens the design it made", async () => {
    render(<CustomizeButton template={TEMPLATE} />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/canvas/inst-1"));
    expect(h.apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = h.apiFetch.mock.calls[0];
    expect(path).toBe("/canvas/instances");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ templateId: "tpl-1" }); // never a revision, a kind, a workspace or an owner
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it("is off while it works, so a double click makes one design, and stays off once it has handed over to the editor", async () => {
    let release!: (v: unknown) => void;
    h.apiFetch.mockReturnValue(new Promise((r) => (release = r)));
    render(<CustomizeButton template={TEMPLATE} />);
    const button = screen.getByRole("button") as HTMLButtonElement;
    await userEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await userEvent.click(button);
    release(made);
    await waitFor(() => expect(h.push).toHaveBeenCalledTimes(1));
    expect(h.apiFetch).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true); // navigating: the page is about to be replaced
  });

  it.each([
    [404, "Template not found"],
    [409, "This template has no published Canvas design to customize."],
  ])("when the server refuses (%i), its own message is shown, nothing opens, and the button works again", async (status, message) => {
    h.apiFetch.mockRejectedValue(Object.assign(new Error(message), { status }));
    render(<CustomizeButton template={TEMPLATE} />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith(message));
    expect(h.push).not.toHaveBeenCalled();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a failure with no message says what to do", async () => {
    h.apiFetch.mockRejectedValue(new Error(""));
    render(<CustomizeButton template={TEMPLATE} />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("The design could not be created. Try again."));
    expect(h.push).not.toHaveBeenCalled();
  });
});
