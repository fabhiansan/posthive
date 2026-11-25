// @vitest-environment jsdom
// My Task as a designer uses it: the list with its tabs, the task page, and above all the Send design card: Mark as done
// stays off until Figma can open the link, Save draft keeps the link to the designer, and nothing is sent without asking.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FigmaCheck, TaskDetail } from "@/lib/design-tasks";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), danger: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }), useParams: () => ({ id: "p1" }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/components/Toast", () => ({ useToast: () => h.toast }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { name: "Dewi Kusuma", avatarUrl: null } }) }));
vi.mock("@/components/templates/TemplatesHeader", () => ({ TemplatesHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => <header><h1>{title}</h1><p>{subtitle}</p></header> }));

import MyTasksPage from "@/app/tasks/page";
import TaskDetailPage from "@/app/tasks/[id]/page";
import { SendDesignCard } from "./SendDesignCard";

const LINK = "https://www.figma.com/design/Xk3aPq/env-enforcement";

const task = (patch: Partial<TaskDetail> = {}): TaskDetail => ({
  postId: "p1", title: "Env data", thumbnail: null, pillar: "Educational", format: "carousel", status: "assigned", assignedBy: "Rina Anggraini",
  deadline: "2030-03-04T10:00:00.000Z", sentAt: "2030-03-01T03:00:00.000Z", doneAt: null, scheduledFor: "2030-03-07T01:00:00.000Z", channels: ["linkedin"], brief: "Carousel 5 slides",
  caption: "Most regional monitoring fails", captionLength: 30, category: "Case Study", briefFull: "Carousel 5 slides, serious tone", referenceUrl: null, postStatus: "draft", approvalStatus: null,
  accounts: [{ platform: "linkedin", displayName: "Braga LinkedIn" }], copywriting: { link: "https://docs.google.com/x", text: "" }, assets: { link: null, text: "ask Rina" },
  figmaUrl: null, designerNote: null, history: [{ kind: "sent", at: "2030-03-01T03:00:00.000Z" }], ...patch,
});

let checkAnswer: FigmaCheck | Error;
let current: TaskDetail;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2030-03-01T03:00:00.000Z"));
  for (const m of [h.apiFetch, h.push, h.toast.success, h.toast.error, h.toast.danger]) m.mockReset();
  checkAnswer = { state: "valid", title: "Braga Backcasting" };
  current = task();
  h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/design-tasks/check-link") {
      if (checkAnswer instanceof Error) throw checkAnswer;
      return checkAnswer;
    }
    if (path === "/design-tasks/p1" && !init?.method) return { task: current };
    if (path === "/design-tasks/p1/draft") return { ok: true };
    if (path === "/design-tasks/p1/done") return { ok: true, title: "Braga Backcasting", checked: true };
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const calls = (path: string) => h.apiFetch.mock.calls.filter((c) => c[0] === path);
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
// the check waits for the typing to pause
const pause = () => act(async () => { await vi.advanceTimersByTimeAsync(700); });

describe("the Send design card: the link and Mark as done", () => {
  const renderCard = (t = task(), onChanged = vi.fn()) => {
    render(<SendDesignCard task={t} onChanged={onChanged} />);
    return onChanged;
  };
  const paste = async (value: string) => {
    const field = screen.getByLabelText(/Figma link/);
    await userEvent.clear(field);
    await userEvent.click(field);
    await userEvent.paste(value);
  };

  it("with nothing pasted Mark as done and Save draft are off, and there is no message", () => {
    renderCard();
    expect(button("Mark as done").disabled).toBe(true);
    expect(button("Save draft").disabled).toBe(true);
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("");
    expect(calls("/design-tasks/check-link")).toHaveLength(0);
  });

  it("a link that is not a Figma file says so at once, asks nothing, and keeps Mark as done off", async () => {
    renderCard();
    await paste("https://example.com/design/x");
    expect(screen.getByText(/Use a Figma link, like/)).toBeTruthy();
    await pause();
    expect(calls("/design-tasks/check-link")).toHaveLength(0);
    expect(button("Mark as done").disabled).toBe(true);
    expect(button("Save draft").disabled).toBe(true); // a draft is not a link Figma cannot open yet, but it must be a Figma link
    expect((screen.getByLabelText(/Figma link/) as HTMLInputElement).getAttribute("aria-invalid")).toBe("true");
  });

  it("a Figma link is checked after the typing pauses; while it is checked Mark as done is off, then valid turns it on", async () => {
    renderCard();
    await paste(LINK);
    expect(screen.getByText("Checking the link…")).toBeTruthy();
    expect(button("Mark as done").disabled).toBe(true);
    await pause();
    expect(await screen.findByText("Link valid · Braga Backcasting")).toBeTruthy();
    expect(calls("/design-tasks/check-link")).toHaveLength(1);
    expect(JSON.parse(calls("/design-tasks/check-link")[0][1].body)).toEqual({ url: LINK });
    expect(button("Mark as done").disabled).toBe(false);
  });

  it("a link Figma cannot open (private) says how to share it, and Mark as done stays off, with a way to check again", async () => {
    checkAnswer = { state: "private" };
    renderCard();
    await paste(LINK);
    await pause();
    expect(await screen.findByText(/Set sharing to “Anyone with the link can view”/)).toBeTruthy();
    expect(button("Mark as done").disabled).toBe(true);
    // the designer shares the file in Figma, then checks again
    checkAnswer = { state: "valid", title: "Braga Backcasting" };
    await userEvent.click(button("Check again"));
    await pause();
    expect(await screen.findByText("Link valid · Braga Backcasting")).toBeTruthy();
    expect(button("Mark as done").disabled).toBe(false);
  });

  it("when Figma cannot be asked the designer is warned, not blocked", async () => {
    checkAnswer = { state: "unreachable" };
    renderCard();
    await paste(LINK);
    await pause();
    expect(await screen.findByText(/Couldn't check the link right now/)).toBeTruthy();
    expect(button("Mark as done").disabled).toBe(false);
  });

  it("a request that fails altogether is the same warning, and an answer for a link that was edited since is not used", async () => {
    checkAnswer = new Error("network");
    renderCard();
    await paste(LINK);
    await pause();
    expect(await screen.findByText(/Couldn't check the link right now/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/Figma link/), "x"); // edited: the old answer is gone at once
    expect(screen.getByText("Checking the link…")).toBeTruthy();
    expect(button("Mark as done").disabled).toBe(true);
  });

  it("Save draft sends the link and the note to the draft route only, tells the designer Marketing cannot see it, and reloads", async () => {
    const onChanged = renderCard();
    await paste(LINK);
    await userEvent.type(screen.getByLabelText(/Note for Marketing/), "  Slide 3 is new ");
    await userEvent.click(button("Save draft"));
    await waitFor(() => expect(calls("/design-tasks/p1/draft")).toHaveLength(1));
    expect(calls("/design-tasks/p1/draft")[0][1].method).toBe("PUT");
    expect(JSON.parse(calls("/design-tasks/p1/draft")[0][1].body)).toEqual({ figmaUrl: LINK, note: "Slide 3 is new" });
    expect(calls("/design-tasks/p1/done")).toHaveLength(0);
    expect(h.toast.success).toHaveBeenCalledWith("Draft saved. Marketing can't see it yet.");
    expect(onChanged).toHaveBeenCalled();
  });

  it("a note alone can be saved as a draft", async () => {
    renderCard();
    await userEvent.type(screen.getByLabelText(/Note for Marketing/), "thinking");
    expect(button("Save draft").disabled).toBe(false);
    await userEvent.click(button("Save draft"));
    await waitFor(() => expect(JSON.parse(calls("/design-tasks/p1/draft")[0][1].body)).toEqual({ figmaUrl: "", note: "thinking" }));
  });

  it("Save draft is off while nothing changed from what is saved", async () => {
    renderCard(task({ status: "progress", figmaUrl: LINK, designerNote: "wip" }));
    expect(button("Save draft").disabled).toBe(true);
    expect((screen.getByLabelText(/Figma link/) as HTMLInputElement).value).toBe(LINK);
    await userEvent.type(screen.getByLabelText(/Note for Marketing/), "!");
    expect(button("Save draft").disabled).toBe(false);
  });

  it("Mark as done asks first, names the post and the link, and sends nothing until Send to Marketing", async () => {
    const onChanged = renderCard();
    await paste(LINK);
    await pause();
    await screen.findByText("Link valid · Braga Backcasting");
    await userEvent.click(button("Mark as done"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Send design to Marketing?")).toBeTruthy();
    expect(within(dialog).getByText("Env data")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Braga Backcasting" }).getAttribute("href")).toBe(LINK);
    expect(calls("/design-tasks/p1/done")).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls("/design-tasks/p1/done")).toHaveLength(0);

    await userEvent.click(button("Mark as done"));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Send to Marketing" }));
    await waitFor(() => expect(calls("/design-tasks/p1/done")).toHaveLength(1));
    expect(JSON.parse(calls("/design-tasks/p1/done")[0][1].body)).toEqual({ figmaUrl: LINK, note: "" });
    expect(h.toast.success).toHaveBeenCalledWith("Design sent to Marketing.");
    expect(onChanged).toHaveBeenCalled();
  });

  it("a refusal from the server (the link turned private since the check) is said, the dialog stays open and nothing reloads", async () => {
    const onChanged = renderCard();
    await paste(LINK);
    await pause();
    await screen.findByText("Link valid · Braga Backcasting");
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path === "/design-tasks/p1/done") throw Object.assign(new Error("Figma can't open this link."), { status: 422 });
      return checkAnswer;
    });
    await userEvent.click(button("Mark as done"));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Send to Marketing" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Figma can't open this link."));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("a done task is the record of what was sent: the link, the note and when, with no field and no button", () => {
    renderCard(task({ status: "done", figmaUrl: LINK, designerNote: "Slide 3 uses the new map", doneAt: "2030-03-03T08:00:00.000Z" }));
    expect(screen.getByText("Design sent to Marketing")).toBeTruthy();
    expect(screen.getByRole("link", { name: LINK }).getAttribute("href")).toBe(LINK);
    expect(screen.getByText("Slide 3 uses the new map")).toBeTruthy();
    expect(screen.getByText(/Sent Sun, 3 Mar 2030, 15:00 WIB/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark as done" })).toBeNull();
    expect(screen.queryByLabelText(/Figma link/)).toBeNull();
  });
});

describe("My Task: the task page", () => {
  it("shows what Marketing wrote, read-only, with the links as buttons and plain text as text", async () => {
    render(<TaskDetailPage />);
    expect(await screen.findByRole("heading", { name: "Design task" })).toBeTruthy();
    expect(screen.getByText("Env data")).toBeTruthy();
    expect(screen.getByText("Most regional monitoring fails")).toBeTruthy();
    expect(screen.getByText("Carousel 5 slides, serious tone")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Open link/ })[0].getAttribute("href")).toBe("https://docs.google.com/x");
    expect(screen.getByText("ask Rina")).toBeTruthy(); // a plan cell that is not a link is not made into one
    expect(screen.getByText(/Design team cannot approve content/)).toBeTruthy();
    expect(screen.getByText("New task")).toBeTruthy();
  });

  it("a task that is not this designer's is 'not found', with a way back", async () => {
    h.apiFetch.mockImplementation(async () => {
      throw Object.assign(new Error("Task not found"), { status: 404 });
    });
    render(<TaskDetailPage />);
    expect(await screen.findByText("Task not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to My task" }).getAttribute("href")).toBe("/tasks");
  });

  it("the history lists the request, a saved draft and the answer, with their times", async () => {
    current = task({ status: "done", figmaUrl: LINK, doneAt: "2030-03-03T08:00:00.000Z", history: [{ kind: "sent", at: "2030-03-01T03:00:00.000Z" }, { kind: "done", at: "2030-03-03T08:00:00.000Z" }] });
    render(<TaskDetailPage />);
    const list = within(await screen.findByRole("list", { name: "History of the task" }));
    expect(list.getByText("Design request sent by Rina A.")).toBeTruthy();
    expect(list.getByText("Sent to Marketing")).toBeTruthy();
  });
});

describe("My Task: the list", () => {
  const item = (patch: Record<string, unknown> = {}) => ({
    postId: "p1", title: "Env data", thumbnail: null, pillar: "Educational", format: "carousel", status: "assigned", assignedBy: "Rina Anggraini", deadline: "2030-03-04T10:00:00.000Z",
    sentAt: null, doneAt: null, scheduledFor: null, channels: ["linkedin"], brief: "b", ...patch,
  });
  const answer = (patch: Record<string, unknown> = {}) => ({
    counts: { assigned: 2, progress: 1, done: 3, waiting: 2 }, tab: "all", total: 6, page: 1, pageCount: 1, pageSize: 10, items: [item(), item({ postId: "p2", title: "Backcasting", status: "progress" })], ...patch,
  });
  const serveList = (build: (path: string) => unknown = () => answer()) => h.apiFetch.mockImplementation(async (path: string) => build(path));

  it("the cards, the tabs with their counts, the rows and the footer", async () => {
    serveList();
    render(<MyTasksPage />);
    expect(await screen.findByRole("row", { name: "Open Env data" })).toBeTruthy();
    const card = (name: string) => screen.getByRole("heading", { name }).closest("[data-slot=card]") as HTMLElement;
    expect(card("Assigned to me").textContent).toContain("2");
    expect(card("In progress").textContent).toContain("1");
    expect(card("Done · waiting for Marketing").textContent).toContain("2");
    expect(within(screen.getByRole("tab", { name: /All tasks/ })).getByText("6")).toBeTruthy();
    expect(within(screen.getByRole("tab", { name: /Assigned/ })).getByText("2")).toBeTruthy();
    expect(within(screen.getByRole("tab", { name: /Done/ })).getByText("3")).toBeTruthy();
    expect(screen.getByText("Showing 2 of 6 tasks assigned to you · 2 done are waiting for Marketing")).toBeTruthy();
    expect(screen.getByText(/Only Admin approves content/)).toBeTruthy();
  });

  it("there is no Revision tab and no approval: that loop is not built", async () => {
    serveList();
    render(<MyTasksPage />);
    await screen.findByRole("row", { name: "Open Env data" });
    expect(screen.queryByRole("tab", { name: /Revision/ })).toBeNull();
    expect(screen.getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["All tasks", "Assigned", "In progress", "Done"]);
  });

  it("a tab asks for its own rows, from page 1", async () => {
    serveList();
    render(<MyTasksPage />);
    await screen.findByRole("row", { name: "Open Env data" });
    await userEvent.click(screen.getByRole("tab", { name: /In progress/ }));
    await waitFor(() => expect(h.apiFetch.mock.calls.some((c) => c[0] === "/design-tasks?tab=progress&page=1")).toBe(true));
  });

  it("a row opens the task page", async () => {
    serveList();
    render(<MyTasksPage />);
    await userEvent.click(await screen.findByRole("row", { name: "Open Env data" }));
    expect(h.push).toHaveBeenCalledWith("/tasks/p1");
  });

  it("a tab with nothing says what it is for; with no task at all it says Marketing has not sent one", async () => {
    serveList(() => answer({ counts: { assigned: 0, progress: 0, done: 0, waiting: 0 }, total: 0, items: [] }));
    render(<MyTasksPage />);
    expect(await screen.findByText("No tasks here")).toBeTruthy();
    expect(screen.getByText(/When Marketing sends you a design request it appears here/)).toBeTruthy();
    expect(screen.getByText(/^No posts from Marketing are waiting for your design/)).toBeTruthy();
  });

  it("pages: a second page is asked for by number", async () => {
    serveList((path) => (path.endsWith("page=2") ? answer({ page: 2, pageCount: 2 }) : answer({ pageCount: 2 })));
    render(<MyTasksPage />);
    await screen.findByRole("row", { name: "Open Env data" });
    await userEvent.click(screen.getByRole("button", { name: "Page 2" }));
    await waitFor(() => expect(h.apiFetch.mock.calls.some((c) => c[0] === "/design-tasks?tab=all&page=2")).toBe(true));
  });

  it("when the tasks cannot be loaded it says so and offers to try again", async () => {
    h.apiFetch.mockRejectedValue(new Error("Network down"));
    render(<MyTasksPage />);
    expect(await screen.findByText("Couldn't load your tasks")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
  });
});
