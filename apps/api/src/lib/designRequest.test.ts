import { describe, expect, it } from "vitest";
import { deadlineProblem, toDesignRequestView } from "./designRequest.js";

describe("deadlineProblem (instants: the deadline comes before the moment the post goes out)", () => {
  const now = new Date("2026-03-01T03:00:00.000Z");
  const publish = new Date("2026-03-07T02:00:00.000Z"); // 09:00 WIB on 7 Mar
  const at = (iso: string) => new Date(iso);

  it("a deadline that has passed, or is this very moment, is past", () => {
    expect(deadlineProblem(at("2026-03-01T02:59:00.000Z"), now, null)).toBe("DEADLINE_PAST");
    expect(deadlineProblem(now, now, null)).toBe("DEADLINE_PAST");
    expect(deadlineProblem(at("2026-03-01T03:01:00.000Z"), now, null)).toBeNull();
  });

  it("the publishing day is fine as long as the deadline is before the publishing time", () => {
    expect(deadlineProblem(at("2026-03-07T01:59:00.000Z"), now, publish)).toBeNull(); // 08:59 WIB
  });

  it("a deadline at the publishing time, or after it, is refused", () => {
    expect(deadlineProblem(publish, now, publish)).toBe("DEADLINE_AFTER_PUBLISH");
    expect(deadlineProblem(at("2026-03-07T02:01:00.000Z"), now, publish)).toBe("DEADLINE_AFTER_PUBLISH");
    expect(deadlineProblem(at("2026-03-08T00:00:00.000Z"), now, publish)).toBe("DEADLINE_AFTER_PUBLISH");
  });

  it("with no publishing time only the past is refused", () => {
    expect(deadlineProblem(at("2030-01-01T00:00:00.000Z"), now, null)).toBeNull();
  });

  it("past wins when both are true (a publishing time already gone)", () => {
    expect(deadlineProblem(at("2026-02-20T00:00:00.000Z"), now, at("2026-02-25T00:00:00.000Z"))).toBe("DEADLINE_PAST");
  });
});

describe("toDesignRequestView", () => {
  const row = (assignee: unknown) => ({
    id: "dr1",
    status: "sent",
    deadline: new Date("2026-03-04T00:00:00.000Z"),
    brief: "Five slides",
    referenceUrl: "https://notion.so/x",
    sentAt: new Date("2026-03-01T03:00:00.000Z"),
    updatedAt: new Date("2026-03-01T03:00:00.000Z"),
    assignee,
  });

  it("answers every date as ISO", () => {
    const v = toDesignRequestView(row({ id: "u1", name: "Rina S.", avatarUrl: null, workspaceMembers: [{ id: "m1" }] }) as never);
    expect(v).toMatchObject({ deadline: "2026-03-04T00:00:00.000Z", sentAt: "2026-03-01T03:00:00.000Z", assignee: { name: "Rina S.", active: true } });
  });

  it("a request with no deadline answers null", () => {
    expect(toDesignRequestView({ ...row(null), deadline: null } as never).deadline).toBeNull();
  });

  it("a designer who left the workspace is not active", () => {
    const v = toDesignRequestView(row({ id: "u1", name: "Rina S.", avatarUrl: null, workspaceMembers: [] }) as never);
    expect(v.assignee).toMatchObject({ active: false });
  });

  it("a deleted account leaves no assignee, and a saved brief has no send time", () => {
    const v = toDesignRequestView({ ...row(null), sentAt: null } as never);
    expect(v.assignee).toBeNull();
    expect(v.sentAt).toBeNull();
  });
});
