import { describe, expect, it } from "vitest";
import { isTaskTab, taskActivities, taskOrder, taskStatusOf, taskTabWhere, toTaskDetail, type TaskRow } from "./designTasks.js";

describe("taskStatusOf", () => {
  it("done is done; an open task is assigned until the designer saves a link or a note", () => {
    expect(taskStatusOf({ status: "done", figmaUrl: "x", designerNote: null })).toBe("done");
    expect(taskStatusOf({ status: "sent", figmaUrl: null, designerNote: null })).toBe("assigned");
    expect(taskStatusOf({ status: "sent", figmaUrl: "https://www.figma.com/design/a/b", designerNote: null })).toBe("progress");
    expect(taskStatusOf({ status: "sent", figmaUrl: null, designerNote: "wip" })).toBe("progress");
  });
});

describe("the tabs", () => {
  it("assigned and progress split the open tasks with no overlap, and done is the answered ones", () => {
    expect(taskTabWhere("assigned")).toEqual({ status: "sent", figmaUrl: null, designerNote: null });
    expect(taskTabWhere("progress")).toEqual({ status: "sent", OR: [{ figmaUrl: { not: null } }, { designerNote: { not: null } }] });
    expect(taskTabWhere("done")).toEqual({ status: "done" });
    expect(taskTabWhere("all")).toEqual({ status: { in: ["sent", "done"] } });
  });

  it("only a known tab is a tab", () => {
    expect(isTaskTab("progress")).toBe(true);
    expect(isTaskTab("revision")).toBe(false);
    expect(isTaskTab(undefined)).toBe(false);
  });

  it("open tasks: soonest deadline first, none last, open before done; done: newest first", () => {
    expect(taskOrder("all")).toEqual([{ status: "desc" }, { deadline: { sort: "asc", nulls: "last" } }, { id: "asc" }]);
    expect(taskOrder("done")).toEqual([{ doneAt: "desc" }, { id: "asc" }]);
  });
});

const row = (patch: Partial<TaskRow> = {}): TaskRow => ({
  id: "dr1",
  status: "sent",
  deadline: null,
  brief: "b".repeat(300),
  referenceUrl: "javascript:alert(1)",
  sentAt: new Date("2026-03-01T03:00:00Z"),
  doneAt: null,
  updatedAt: new Date("2026-03-02T03:00:00Z"),
  figmaUrl: null,
  designerNote: null,
  createdById: "rina",
  createdBy: null,
  postJob: {
    id: "p1",
    status: "draft",
    approvalStatus: null,
    scheduledFor: null,
    content: JSON.stringify({ title: "T", designCopy: "ask Rina on Slack", assetNotes: "javascript:alert(1)" }),
    userId: "rina",
    user: { name: "Rina A." },
    targets: [],
  },
  ...patch,
});

describe("toTaskDetail", () => {
  it("a brief row is cut short and the whole brief is kept; a reference that is not a web address is dropped", () => {
    const d = toTaskDetail(row());
    expect(d.brief).toHaveLength(160);
    expect(d.briefFull).toHaveLength(300);
    expect(d.referenceUrl).toBeNull();
  });

  it("a plan cell that is text stays text and one that is not a web address is never a link", () => {
    const d = toTaskDetail(row());
    expect(d.copywriting).toEqual({ link: null, text: "ask Rina on Slack" });
    expect(d.assets).toEqual({ link: null, text: "javascript:alert(1)" });
  });

  it("the history is the send, the last saved draft while the task is open, and the answer", () => {
    expect(toTaskDetail(row()).history.map((e) => e.kind)).toEqual(["sent"]);
    expect(toTaskDetail(row({ figmaUrl: "https://www.figma.com/design/a/b" })).history.map((e) => e.kind)).toEqual(["sent", "draft"]);
    expect(toTaskDetail(row({ status: "done", doneAt: new Date("2026-03-03T03:00:00Z") })).history.map((e) => e.kind)).toEqual(["sent", "done"]);
  });

  it("the assigner is the sender, else the post's author", () => {
    expect(toTaskDetail(row()).assignedBy).toBe("Rina A.");
    expect(toTaskDetail(row({ createdBy: { name: "Putri" } })).assignedBy).toBe("Putri");
  });
});

describe("taskActivities", () => {
  const since = new Date("2026-11-10T00:00:00Z");
  const post = (title: string) => ({ content: JSON.stringify({ title }) });

  it("builds assigned, sent and template events, newest first, and counts only what the designer did as theirs", () => {
    const events = taskActivities(
      "dewi",
      {
        assigned: [{ sentAt: new Date("2026-11-16T07:22:00Z"), createdBy: { name: "Rina A." }, postJob: post("A") }],
        answered: [{ doneAt: new Date("2026-11-17T01:55:00Z"), postJob: post("B") }],
        templates: [{ name: "C", pillar: "Educational", createdAt: new Date("2026-11-16T09:00:00Z"), userId: "other", user: { name: "Putri" } }],
      },
      since,
      10,
    );
    expect(events.map((e) => [e.kind, e.title, e.mine])).toEqual([["sent", "B", true], ["template", "C", false], ["assigned", "A", false]]);
  });

  it("a task that lost its send time (cancelled) and an event older than the window are not events", () => {
    const events = taskActivities(
      "dewi",
      { assigned: [{ sentAt: null, createdBy: null, postJob: post("A") }], answered: [{ doneAt: new Date("2026-10-01T00:00:00Z"), postJob: post("B") }], templates: [] },
      since,
      10,
    );
    expect(events).toEqual([]);
  });

  it("keeps the newest few and sends nothing but the event", () => {
    const src = { assigned: [1, 2, 3].map((n) => ({ sentAt: new Date(`2026-11-1${n}T00:00:00Z`), createdBy: null, postJob: post(`P${n}`) })), answered: [], templates: [] };
    const events = taskActivities("dewi", src, since, 2);
    expect(events.map((e) => e.title)).toEqual(["P3", "P2"]);
    expect(Object.keys(events[0]).sort()).toEqual(["at", "by", "kind", "mine", "pillar", "title"]);
  });
});
