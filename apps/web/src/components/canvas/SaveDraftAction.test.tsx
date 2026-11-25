// @vitest-environment jsdom
// "Save as draft" in the Canvas editor. The rule under test: leave and say "saved" ONLY when the server has confirmed everything
// (flush() resolved true); on anything else stay, keep the changes, and never show success.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({ push: vi.fn(), toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => h.toast }));

import { SaveDraftAction } from "./SaveDraftAction";

const button = () => screen.getByRole("button", { name: /Save as draft|Saving/ }) as HTMLButtonElement;

beforeEach(() => {
  h.push.mockReset();
  Object.values(h.toast).forEach((f) => f.mockReset());
});
afterEach(cleanup);

describe("SaveDraftAction", () => {
  it("saved: waits for the confirmation, THEN says so and goes to My designs", async () => {
    let confirm!: (ok: boolean) => void;
    const flush = vi.fn(() => new Promise<boolean>((r) => (confirm = r)));
    render(<SaveDraftAction flush={flush} />);
    await userEvent.click(button());
    expect(flush).toHaveBeenCalledTimes(1);
    expect(h.push).not.toHaveBeenCalled(); // not before the server answers
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(button().disabled).toBe(true);
    confirm(true);
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/canvas"));
    expect(h.toast.success).toHaveBeenCalledWith("Design draft saved. Find it under My designs.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("could not be saved (conflict, lost connection, ended session, archived): stays, says it was NOT saved, never claims success, never navigates", async () => {
    const flush = vi.fn(async () => false);
    render(<SaveDraftAction flush={flush} />);
    await userEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toContain("Your draft was not saved");
    expect(screen.getByRole("alert").textContent).toContain("Your changes are still here");
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false); // can try again
  });

  it("a flush that throws is a failure too, never a success", async () => {
    render(<SaveDraftAction flush={vi.fn(async () => { throw new Error("boom"); })} />);
    await userEvent.click(button());
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });

  it("trying again after a failure works and clears the message", async () => {
    const flush = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<SaveDraftAction flush={flush} />);
    await userEvent.click(button());
    await screen.findByRole("alert");
    await userEvent.click(button());
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/canvas"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("a double click sends ONE flush", async () => {
    let confirm!: (ok: boolean) => void;
    const flush = vi.fn(() => new Promise<boolean>((r) => (confirm = r)));
    render(<SaveDraftAction flush={flush} />);
    const b = button();
    await userEvent.click(b);
    await userEvent.click(b);
    expect(flush).toHaveBeenCalledTimes(1);
    confirm(true);
    await waitFor(() => expect(h.push).toHaveBeenCalledTimes(1));
  });

  it("is disabled when the design can no longer be saved (archived or deleted)", () => {
    render(<SaveDraftAction flush={vi.fn()} disabled />);
    expect(button().disabled).toBe(true);
  });

  it("says in words that this is a Canvas design draft, not a post", () => {
    render(<SaveDraftAction flush={vi.fn()} />);
    expect(button().getAttribute("title")).toMatch(/Canvas/);
    expect(button().getAttribute("title")).toMatch(/doesn't create a post or send it for review/);
    expect(button().textContent).toMatch(/Canvas design draft: no post is created and nothing is sent for review/);
  });
});
