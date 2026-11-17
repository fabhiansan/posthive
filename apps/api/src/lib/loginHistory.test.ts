import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ created: [] as any[], fail: false }));

vi.mock("./prisma.js", () => ({
  prisma: {
    loginEvent: {
      create: vi.fn(async (args: any) => {
        if (h.fail) throw new Error("db down");
        h.created.push(args);
        return {};
      }),
    },
  },
}));

import { LOGIN_HISTORY_DAYS, WRONG_PASSWORD, recordLoginEvent } from "./loginHistory.js";

beforeEach(() => {
  h.created = [];
  h.fail = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recordLoginEvent", () => {
  it("a sign-in is a success with the browser it came from", async () => {
    await recordLoginEvent({ userId: "u1", userAgent: "  Chrome/130  " });
    expect(h.created[0].data).toEqual({ userId: "u1", userAgent: "Chrome/130", success: true, failure: null });
  });

  it("a wrong password is a failure that says so", async () => {
    await recordLoginEvent({ userId: "u1", userAgent: "Firefox/132", failure: WRONG_PASSWORD });
    expect(h.created[0].data).toMatchObject({ success: false, failure: "Wrong password" });
  });

  it("no browser header is stored as nothing, and a huge one is cut", async () => {
    await recordLoginEvent({ userId: "u1" });
    await recordLoginEvent({ userId: "u1", userAgent: "a".repeat(5000) });
    expect(h.created[0].data.userAgent).toBeNull();
    expect(h.created[1].data.userAgent).toHaveLength(300);
  });

  it("a history that cannot be written never stops the sign-in: it resolves, and the error is logged", async () => {
    h.fail = true;
    await expect(recordLoginEvent({ userId: "u1" })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("keeps 30 days, the same number the page says", () => {
    expect(LOGIN_HISTORY_DAYS).toBe(30);
  });
});
