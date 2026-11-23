// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./session", () => ({ notifySessionExpired: vi.fn() }));

import { apiFetch, errorText } from "./api";

describe("errorText: the words of a refusal", () => {
  it("a sentence is the sentence", () => {
    expect(errorText("Job not found")).toBe("Job not found");
  });

  it("a flattened zod error says the field and the issue, not [object Object]", () => {
    expect(errorText({ formErrors: [], fieldErrors: { designFigmaUrl: ["Use an https link"] } })).toBe("designFigmaUrl: Use an https link");
  });

  it("an issue of the whole body comes first", () => {
    expect(errorText({ formErrors: ["Expected object"], fieldErrors: { a: ["x"] } })).toBe("Expected object");
  });

  it("anything else has no words", () => {
    expect(errorText(undefined)).toBeNull();
    expect(errorText({})).toBeNull();
    expect(errorText({ formErrors: [], fieldErrors: {} })).toBeNull();
  });
});

describe("apiFetch: the message of a failed call", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());
  const fail = (status: number, body: unknown) =>
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status, text: async () => JSON.stringify(body) });

  it("keeps the sentence a route sends", async () => {
    fail(404, { error: "Job not found" });
    await expect(apiFetch("/jobs/x")).rejects.toThrow("Job not found");
  });

  it("turns a validation object into words, and still carries the body for the callers that read it", async () => {
    fail(400, { error: { formErrors: [], fieldErrors: { designFigmaUrl: ["Use an https link"] } } });
    await expect(apiFetch("/jobs/x")).rejects.toMatchObject({ message: "designFigmaUrl: Use an https link", status: 400 });
  });

  it("falls back to the status when the body says nothing", async () => {
    fail(500, {});
    await expect(apiFetch("/jobs/x")).rejects.toThrow("500 error");
  });
});
