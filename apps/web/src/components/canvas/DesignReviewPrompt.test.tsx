// @vitest-environment jsdom
// The hand-off from the Canvas editor to Compose: /compose?design=<id>. It must do nothing without that parameter, never disturb
// Compose's own ?template= handling, submit only the SAVED design with an optional note, and say what happened.
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

import { DesignReviewPrompt, NOTE_MAX, submitProblem } from "./DesignReviewPrompt";

const SUBMITTED = { latestReviewStatus: null, hasChangesSinceSubmitted: false, submissionNumber: null, submittedVersion: null, workingVersion: 3, submittedAt: null, latestReviewId: null, comment: null, decidedAt: null };
const review = (over: Record<string, unknown> = {}) => ({ ...SUBMITTED, ...over });

let instance: { id: string; name: string; version: number; review: unknown };
let submitFails: unknown;

const openAt = (url: string) => window.history.replaceState(null, "", url);
const posts = () => h.apiFetch.mock.calls.filter(([, i]) => i?.method === "POST");

beforeEach(() => {
  vi.clearAllMocks();
  openAt("/compose");
  instance = { id: "i1", name: "Spring sale", version: 3, review: review() };
  submitFails = null;
  h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      if (submitFails) throw submitFails;
      return { submission: { id: "s1", number: 1, createdAt: "x" }, review: { id: "r1", status: "pending" } };
    }
    if (path === "/canvas/instances/i1") return { instance };
    throw Object.assign(new Error("Design not found"), { status: 404, data: { error: "Design not found" } });
  });
});
afterEach(() => {
  cleanup();
  openAt("/");
});

describe("without the parameter", () => {
  it("renders nothing and asks the server nothing (a plain Compose visit is untouched)", () => {
    const { container } = render(<DesignReviewPrompt />);
    expect(container.innerHTML).toBe("");
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("Compose's own ?template= address is left exactly as it is, and nothing is asked", () => {
    openAt("/compose?template=t1");
    const { container } = render(<DesignReviewPrompt />);
    expect(container.innerHTML).toBe("");
    expect(h.apiFetch).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?template=t1");
  });

  it("an empty ?design= is no request", () => {
    openAt("/compose?design=");
    render(<DesignReviewPrompt />);
    expect(screen.queryByText("Submit for design Review")).toBeNull();
    expect(h.apiFetch).not.toHaveBeenCalled();
  });
});

describe("the confirmation", () => {
  it("opens 'Submit for design Review' with the design's name and the saved version, from the server (never from the address)", async () => {
    openAt("/compose?design=i1");
    render(<DesignReviewPrompt />);
    expect(await screen.findByText("Submit for design Review")).toBeTruthy();
    expect(await screen.findByText(/“Spring sale” \(saved version 3\)/)).toBeTruthy();
    expect(h.apiFetch).toHaveBeenCalledWith("/canvas/instances/i1");
    expect(screen.queryByText("This replaces your pending submission.")).toBeNull();
  });

  it("submits the saved version with the note the person typed, and says 'Submitted to Design Team'", async () => {
    openAt("/compose?design=i1");
    render(<DesignReviewPrompt />);
    await screen.findByText(/saved version 3/);
    await userEvent.type(screen.getByLabelText(/Note for the designer/), "  Please check the headline ");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Submitted to Design Team", { selector: "h2" })).toBeTruthy();
    expect(posts()).toHaveLength(1);
    const [path, init] = posts()[0];
    expect(path).toBe("/canvas/instances/i1/submit");
    expect(JSON.parse(init.body)).toEqual({ version: 3, note: "Please check the headline" }); // trimmed, and nothing but these two
    expect(h.toast.success).toHaveBeenCalledWith("Submitted to Design Team");
  });

  it("the note is optional: without one the body is just the version", async () => {
    openAt("/compose?design=i1");
    render(<DesignReviewPrompt />);
    await screen.findByText(/saved version 3/);
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByText("Submitted to Design Team", { selector: "h2" });
    expect(JSON.parse(posts()[0][1].body)).toEqual({ version: 3 });
  });

  it("a note is held to 500 characters in the field, with a counter", async () => {
    openAt("/compose?design=i1");
    render(<DesignReviewPrompt />);
    await screen.findByText(/saved version 3/);
    const field = screen.getByLabelText(/Note for the designer/) as HTMLTextAreaElement;
    expect(NOTE_MAX).toBe(500);
    expect(field.maxLength).toBe(500);
    await userEvent.type(field, "abc");
    expect(screen.getByText("3 / 500")).toBeTruthy();
  });

  it("with a pending submission it says the new one replaces it", async () => {
    instance.review = review({ latestReviewStatus: "pending", hasChangesSinceSubmitted: true });
    openAt("/compose?design=i1");
    render(<DesignReviewPrompt />);
    expect(await screen.findByText("This replaces your pending submission.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("when nothing changed since the last submission it says so, offers no note field, and Submit is off (nothing is sent)", async () => {
    instance.review = review({ latestReviewStatus: "approved", hasChangesSinceSubmitted: false });
    openAt("/compose?design=i1");
    render(<DesignReviewPrompt />);
    expect(await screen.findByText("Nothing has changed since you last submitted this design.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText(/Note for the designer/)).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("a design that cannot be loaded says why, and Submit stays off", async () => {
    openAt("/compose?design=nope");
    render(<DesignReviewPrompt />);
    expect(await screen.findByText("This design doesn't exist any more.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it("Submit is off while the design is still loading", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = h.apiFetch.getMockImplementation()!;
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/canvas/instances/i1") await gate;
      return original(path, init);
    });
    openAt("/compose?design=i1");
    render(<DesignReviewPrompt />);
    expect(await screen.findByText("Loading your design…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await screen.findByText(/saved version 3/);
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("when the server refuses", () => {
  it.each([
    [{ status: 409, data: { code: "NO_CHANGES", error: "x" } }, "Nothing has changed since you last submitted this design."],
    [{ status: 409, data: { code: "NO_REVIEWER", error: "x" } }, "This workspace has no designer to review designs yet. Ask an admin to invite one."],
    [{ status: 409, data: { code: "VERSION_CONFLICT", error: "x" } }, "This design was changed somewhere else. Open it again and try again."],
    [{ status: 404, data: { code: "DESIGN_ARCHIVED", error: "x" } }, "This design was archived, so it can't be submitted."],
    [{ status: 409, data: { code: "UNKNOWN_ASSET", error: "x" } }, "An image in this design is no longer available. Replace it and try again."],
    [{ status: 429, data: { error: "Rate limit" } }, "You are submitting too fast. Wait a moment and try again."],
  ])("%j: the person is told in words, and the dialog stays open for another try (nothing is shown as submitted)", async (failure, words) => {
    submitFails = Object.assign(new Error("refused"), failure);
    openAt("/compose?design=i1");
    render(<DesignReviewPrompt />);
    await screen.findByText(/saved version 3/);
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith(words));
    expect(screen.getByText("Submit for design Review")).toBeTruthy(); // still open
    expect(screen.queryByText("Submitted to Design Team", { selector: "h2" })).toBeNull();
    expect(h.toast.success).not.toHaveBeenCalled();
    submitFails = null; // and trying again works
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Submitted to Design Team", { selector: "h2" })).toBeTruthy();
  });

  it("submitProblem falls back to the server's sentence, then to a plain one", () => {
    expect(submitProblem({ status: 400, data: { error: "version must be a whole number" } })).toBe("version must be a whole number");
    expect(submitProblem(new Error("boom"))).toBe("boom");
    expect(submitProblem(null)).toBe("The design could not be submitted.");
    // Phase 7: a server error and a lost connection each get their own plain sentence instead of the generic one (canvasProblem)
    expect(submitProblem({ status: 500 })).toMatch(/problem on its side/i);
    expect(submitProblem({ status: 503 })).toMatch(/busy/i);
    // ...and with the bodies the API really sends: the app's error handler answers `error: err.name` ("Error"), the auth gate "Service
    // Unavailable". apiFetch keeps that body in `data`, and it must never reach the person as the toast text.
    expect(submitProblem({ status: 500, message: "Error", data: { statusCode: 500, error: "Error", message: "Internal Server Error" } })).toMatch(/problem on its side/i);
    expect(submitProblem({ status: 503, message: "Service Unavailable", data: { statusCode: 503, error: "Service Unavailable", message: "Sign-in is busy" } })).toMatch(/busy/i);
    expect(submitProblem({ status: 429, data: { error: "Too Many Requests" } })).toBe("You are submitting too fast. Wait a moment and try again.");
    expect(submitProblem(new TypeError("Failed to fetch"))).toMatch(/offline/i);
  });
});

describe("the address", () => {
  it("Cancel closes the dialog, sends nothing, removes ONLY the design parameter and keeps ?template= and the hash", async () => {
    openAt("/compose?template=t1&design=i1#top");
    render(<DesignReviewPrompt />);
    await screen.findByText(/saved version 3/);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Submit for design Review")).toBeNull());
    expect(posts()).toHaveLength(0);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/compose?template=t1#top");
  });

  it("after a submit the parameter is gone once the person moves on, and a reload does not ask again", async () => {
    openAt("/compose?design=i1");
    render(<DesignReviewPrompt />);
    await screen.findByText(/saved version 3/);
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByText("Submitted to Design Team", { selector: "h2" });
    await userEvent.click(screen.getByRole("button", { name: "Stay in Compose" }));
    await waitFor(() => expect(screen.queryByText("Submitted to Design Team", { selector: "h2" })).toBeNull());
    expect(window.location.search).toBe("");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("'Back to my design' opens the design in Canvas and clears the parameter", async () => {
    openAt("/compose?design=i1");
    render(<DesignReviewPrompt />);
    await screen.findByText(/saved version 3/);
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await userEvent.click(await screen.findByRole("button", { name: "Back to my design" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/canvas/i1"));
    expect(window.location.search).toBe("");
  });

  it("the design id from the address is encoded in every request path, so it cannot change it", async () => {
    openAt("/compose?design=" + encodeURIComponent("a/b?c"));
    render(<DesignReviewPrompt />);
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalled());
    expect(h.apiFetch.mock.calls[0][0]).toBe("/canvas/instances/a%2Fb%3Fc");
  });
});
