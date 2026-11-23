import { describe, expect, it } from "vitest";
import { promoteRefusal } from "./promoteGate.js";

const job = (patch: Record<string, unknown> = {}) => ({ approvalStatus: null, designRequest: null, targets: [{ id: "t1" }], ...patch }) as Parameters<typeof promoteRefusal>[0];

describe("promoteRefusal", () => {
  it("a plain draft with an account can be scheduled", () => {
    expect(promoteRefusal(job())).toBeNull();
  });

  it("a request that is with the designer refuses it: 409 IN_DESIGN", () => {
    expect(promoteRefusal(job({ designRequest: { status: "sent" } }))).toMatchObject({ status: 409, body: { code: "IN_DESIGN" } });
  });

  it("a saved brief that was not sent does not", () => {
    expect(promoteRefusal(job({ designRequest: { status: "draft" } }))).toBeNull();
  });

  it("approving a post that is already in review is not blocked by the request", () => {
    expect(promoteRefusal(job({ approvalStatus: "pending", designRequest: { status: "sent" } }))).toBeNull();
  });

  it("a draft with no account is refused: 422 NO_ACCOUNT, so nothing is 'published' to no one", () => {
    expect(promoteRefusal(job({ targets: [] }))).toMatchObject({ status: 422, body: { code: "NO_ACCOUNT" } });
  });

  it("the design comes first when both are true", () => {
    expect(promoteRefusal(job({ targets: [], designRequest: { status: "sent" } }))?.status).toBe(409);
  });
});
