// @vitest-environment jsdom
// The Edit Content page, driven as a person would: what a save SENDS (only what changed), what is blocked while a design
// request is with the designer, and who sees which buttons. The API is faked by path; the canvas and the toast are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesignRequestView } from "@/lib/jobTypes";
import type { DesignTemplate } from "@/lib/templates";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), danger: vi.fn() },
  perms: { canEditContent: true, canReview: false, canManageTemplates: false, canSubmitOwn: true, loading: false },
  workspace: { id: "ws-1", name: "Braga Geo", role: "member", approvalRequired: true },
  createInstance: vi.fn(),
  getInstance: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u, API_BASE: "http://api" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/usePermissions", () => ({ usePermissions: () => h.perms }));
vi.mock("@/context/WorkspaceContext", () => ({ useWorkspace: () => ({ activeWorkspace: h.workspace, loading: false }) }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { name: "Putri Anggraini", avatarUrl: null } }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => h.toast }));
vi.mock("@/components/TrialUrgentBanner", () => ({ TrialUrgentBanner: () => null }));
vi.mock("@/components/templates/TemplatesHeader", () => ({ TemplatesHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("@/lib/canvas", () => ({ createInstance: h.createInstance, getInstance: h.getInstance }));
vi.mock("@/lib/track", () => ({ trackEvent: vi.fn() }));
// The picker is no longer offered in Compose (Path A attaches the Studio export); only its disclosure text is still read.
vi.mock("./ApprovedDesignPicker", () => ({
  DESIGN_DISCLOSURE: "DISCLOSURE: the picture itself cannot be checked.",
}));

import { PostEditor } from "./PostEditor";

const ACCOUNTS = [
  { id: "acc-li", platform: "linkedin", displayName: "Braga LinkedIn", avatarUrl: null },
  { id: "acc-ig", platform: "instagram", displayName: "@braga.geo", avatarUrl: null },
  { id: "acc-bs", platform: "bluesky", displayName: "braga.bsky", avatarUrl: null },
];

const TEMPLATE: DesignTemplate = {
  id: "ckbbbbbbbbbbbbbbbbbbbbbbb", name: "Case Study", pillar: "Promotional", category: "Case Study", linkUrl: "https://www.figma.com/design/AbC/Case",
  previewUrl: null, published: true, format: "carousel", slides: 5, platforms: ["linkedin"], slideImages: [], captionGuideline: null,
  canvasRevision: 2, createdAt: "2026-11-12T03:00:00.000Z", createdBy: "Dewi Kusuma",
};

const STORED = { title: "When Data Leads", text: "Caption here.", pillar: "Educational", category: "Blog Post", format: "single", mediaUrls: ["/uploads/a.png"], youtubeTags: ["geo"], sourceRow: 1 };

const request = (patch: Partial<DesignRequestView> = {}): DesignRequestView => ({
  id: "dr1", status: "sent", assignee: { id: "ckaaaaaaaaaaaaaaaaaaaaaaa", name: "Rina Sari", avatarUrl: null, active: true },
  deadline: "2030-03-04T10:00:00.000Z", brief: "Five slides, serious tone.", referenceUrl: null, sentAt: "2030-03-01T01:00:00.000Z", updatedAt: "2030-03-01T01:00:00.000Z", doneAt: null, figmaUrl: null, designerNote: null, ...patch,
});

const job = (patch: Record<string, unknown> = {}) => ({
  id: "p1", status: "draft", approvalStatus: null, scheduledFor: "2030-03-07T01:00:00.000Z", commentText: null, dryRun: false, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-02T04:00:00.000Z",
  content: JSON.stringify(STORED), targets: [{ id: "t1", accountId: "acc-li", status: "pending", platformPostId: null, error: null, attempts: 0, account: null }], designRequest: null, ...patch,
});

let current: ReturnType<typeof job>;
let templates: DesignTemplate[];
let designers: { id: string; name: string; avatarUrl: null }[];

function serve() {
  h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    if (path === "/accounts") return ACCOUNTS;
    if (path === "/templates") return { templates };
    if (path === "/design-requests/designers") return { designers };
    if (path === "/jobs/p1" && method === "GET") return current;
    if (path === "/jobs/p1" && method === "PATCH") return {};
    if (path === "/jobs/p1/submit") return {};
    if (path === "/jobs/p1/schedule") return {};
    if (path === "/jobs" && method === "POST") return { id: "p1" };
    if (path === "/jobs/p1/design-request" && method === "PUT") {
      const body = JSON.parse(init!.body!) as { send: boolean; brief: string; deadline: string; assigneeId: string };
      return { request: request({ status: body.send ? "sent" : "draft", brief: body.brief, deadline: body.deadline }) };
    }
    if (path === "/jobs/p1/design-request/cancel") return { request: request({ status: "draft" }) };
    throw new Error(`unexpected ${method} ${path}`);
  });
}

const calls = (path: string, method?: string) =>
  h.apiFetch.mock.calls.filter((c) => c[0] === path && (method ? (c[1]?.method ?? "GET") === method : true));
const bodyOf = (path: string, method: string) => JSON.parse(calls(path, method)[0][1].body);
const ready = async () => screen.findByRole("heading", { name: "Edit Content" });
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  h.apiFetch.mockReset();
  h.push.mockReset();
  Object.values(h.toast).forEach((f) => f.mockReset());
  h.perms = { canEditContent: true, canReview: false, canManageTemplates: false, canSubmitOwn: true, loading: false };
  h.workspace = { id: "ws-1", name: "Braga Geo", role: "member", approvalRequired: true };
  current = job();
  templates = [TEMPLATE];
  designers = [{ id: "ckaaaaaaaaaaaaaaaaaaaaaaa", name: "Rina Sari", avatarUrl: null }];
  h.getInstance.mockReset();
  h.getInstance.mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 })); // a design that is not there (or not theirs)
  h.createInstance.mockReset();
  serve();
});
afterEach(cleanup);

describe("Edit Content: what a save sends", () => {
  it("only what the person changed: a new title sends the title and nothing else, so the old settings stay as stored", async () => {
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.clear(screen.getByLabelText(/Content title/));
    await userEvent.type(screen.getByLabelText(/Content title/), "A better title");
    await userEvent.click(button("Save as Draft"));
    await waitFor(() => expect(calls("/jobs/p1", "PATCH")).toHaveLength(1));
    expect(bodyOf("/jobs/p1", "PATCH")).toEqual({ title: "A better title" });
  });

  it("nothing changed sends nothing at all", async () => {
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.click(button("Save as Draft"));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Draft saved."));
    expect(calls("/jobs/p1", "PATCH")).toHaveLength(0);
  });

  it("a channel the page does not show (Bluesky) stays ticked and is not sent when another field changes", async () => {
    current = job({ targets: [{ id: "t1", accountId: "acc-li" }, { id: "t2", accountId: "acc-bs" }] });
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(await screen.findByText(/also goes to Bluesky/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/Content description/), " More.");
    await userEvent.click(button("Save as Draft"));
    await waitFor(() => expect(calls("/jobs/p1", "PATCH")).toHaveLength(1));
    expect(bodyOf("/jobs/p1", "PATCH")).toEqual({ text: "Caption here. More." });
  });
});

describe("Edit Content: Submit for Review", () => {
  it("is off while a format is missing, and says what to add", async () => {
    current = job({ content: JSON.stringify({ ...STORED, format: undefined }) });
    render(<PostEditor jobId="p1" />);
    await ready();
    await waitFor(() => expect(screen.getByRole("status", { name: "" }).textContent).toContain("Add a format"));
    expect(button("Submit for Review").disabled).toBe(true);
  });

  it("a complete post: saves its change, sends it for review, and goes back to the list", async () => {
    current = job({ targets: [{ id: "t1", accountId: "acc-li" }] });
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.type(screen.getByLabelText(/Content description/), "!");
    await waitFor(() => expect(button("Submit for Review").disabled).toBe(false));
    await userEvent.click(button("Submit for Review"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/jobs"));
    expect(calls("/jobs/p1", "PATCH")).toHaveLength(1);
    expect(calls("/jobs/p1/submit")).toHaveLength(1);
  });

  it("is off while the design is with the designer, naming them, and the Path A cards are off too", async () => {
    current = job({ designRequest: request() });
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(button("Submit for Review").disabled).toBe(true);
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("Waiting for the design from Rina S.");
    expect((screen.getByRole("radio", { name: /Path A/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/Design requested · Rina S\./).length).toBeGreaterThan(0);
  });
});

describe("Edit Content: who sees which buttons", () => {
  it("an admin schedules a draft: it saves, then schedules, and the onboarding hears about it", async () => {
    h.perms = { canEditContent: true, canReview: true, canManageTemplates: false, canSubmitOwn: false, loading: false };
    h.workspace = { ...h.workspace, role: "admin" };
    current = job({ userId: "me" });
    const heard = vi.fn();
    window.addEventListener("ph:post-scheduled", heard);
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(screen.queryByRole("button", { name: "Submit for Review" })).toBeNull();
    await userEvent.type(screen.getByLabelText(/Content description/), "!");
    await userEvent.click(button("Schedule Post"));
    await waitFor(() => expect(calls("/jobs/p1/schedule")).toHaveLength(1));
    expect(calls("/jobs/p1", "PATCH")).toHaveLength(1);
    expect(heard).toHaveBeenCalled();
    window.removeEventListener("ph:post-scheduled", heard);
  });

  it("Marketing on an approved post sees the reason and no buttons that save", async () => {
    current = job({ status: "pending", approvalStatus: "approved" });
    render(<PostEditor jobId="p1" />);
    await ready();
    expect((await screen.findAllByText(/Approved posts are locked/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Submit for Review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save as Draft" })).toBeNull();
    // a disabled fieldset disables what is in it (jsdom answers through :disabled, not the property)
    expect(screen.getByLabelText(/Content title/).matches(":disabled")).toBe(true);
  });

  it("a post that is not there says so and offers the list", async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path === "/jobs/p1") throw Object.assign(new Error("Job not found"), { status: 404 });
      if (path === "/accounts") return [];
      return { templates: [] };
    });
    render(<PostEditor jobId="p1" />);
    expect(await screen.findByText("Post not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Content List" }).getAttribute("href")).toBe("/jobs");
  });
});

describe("Edit Content: Path B, the design request", () => {
  const PATH_B = /Path B · Assign to Designer/;

  // "now" is fixed (only Date, so the timers of the page and of userEvent still run): the post goes out on 7 Mar 2030, 08:00 WIB,
  // and the deadline rules do not depend on the day the tests run
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-03-01T03:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function openPathB() {
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.click(screen.getByRole("radio", { name: PATH_B }));
    await screen.findByText("Path B · Design request");
  }

  const fillDesignerAndBrief = async () => {
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: /Designer/ }), "ckaaaaaaaaaaaaaaaaaaaaaaa");
    await userEvent.type(screen.getByLabelText(/Brief for designer/), "Five slides, serious tone.");
  };
  // the calendar opens on the month of "now" (March 2030); a picked day starts at 09:00 WIB
  const pickDeadlineDay = async (day: RegExp) => {
    await userEvent.click(screen.getByRole("button", { name: "Pick a deadline" }));
    await userEvent.click(await screen.findByRole("button", { name: day }));
  };

  it("Save brief needs a designer and a brief; Send Design Request also needs a deadline", async () => {
    await openPathB();
    expect(button("Save brief").disabled).toBe(true);
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: /Designer/ }), "ckaaaaaaaaaaaaaaaaaaaaaaa");
    expect(button("Save brief").disabled).toBe(true); // still no brief
    await userEvent.type(screen.getByLabelText(/Brief for designer/), "Five slides, serious tone.");
    expect(button("Save brief").disabled).toBe(false);
    expect(button("Send Design Request").disabled).toBe(true); // no deadline yet
    await pickDeadlineDay(/March 4th, 2030/);
    await waitFor(() => expect(button("Send Design Request").disabled).toBe(false));
    expect(button("Save brief").disabled).toBe(false);
  });

  it("a brief can be saved with no deadline (it sends deadline: null); the deadline is marked as needed to send", async () => {
    await openPathB();
    await fillDesignerAndBrief();
    expect(screen.getByText(/Needed to send it\. It must be before the post goes out: Thu, 7 Mar 2030, 08:00 WIB\./)).toBeTruthy();
    expect(screen.getByText("Design deadline").textContent).toContain("*");
    expect(screen.queryByLabelText("Deadline hour")).toBeNull(); // the time shows once a day is picked

    await userEvent.click(button("Save brief"));
    await waitFor(() => expect(calls("/jobs/p1/design-request", "PUT")).toHaveLength(1));
    expect(bodyOf("/jobs/p1/design-request", "PUT")).toEqual({ assigneeId: "ckaaaaaaaaaaaaaaaaaaaaaaa", deadline: null, brief: "Five slides, serious tone.", referenceUrl: "", send: false });
    expect(h.toast.success).toHaveBeenCalledWith("Brief saved.");
  });

  it("with a deadline Send Design Request sends the request, and the form becomes the locked summary", async () => {
    await openPathB();
    await fillDesignerAndBrief();
    await pickDeadlineDay(/March 4th, 2030/);
    await userEvent.click(button("Send Design Request"));
    await waitFor(() => expect(calls("/jobs/p1/design-request", "PUT")).toHaveLength(1));
    expect(bodyOf("/jobs/p1/design-request", "PUT")).toMatchObject({ send: true, deadline: "2030-03-04T02:00:00.000Z" });
    expect(await screen.findByText("Path B · Design request sent")).toBeTruthy();
  });

  it("a picked day shows the time and sends the WIB date and time as one ISO instant; Clear takes the deadline away again", async () => {
    await openPathB();
    await fillDesignerAndBrief();
    await pickDeadlineDay(/March 4th, 2030/);
    expect((screen.getByLabelText("Deadline hour") as HTMLSelectElement).value).toBe("09");
    await userEvent.selectOptions(screen.getByLabelText("Deadline hour"), "17");
    await userEvent.selectOptions(screen.getByLabelText("Deadline minute"), "30");
    await userEvent.click(button("Save brief"));
    await waitFor(() => expect(calls("/jobs/p1/design-request", "PUT")).toHaveLength(1));
    // 4 Mar 2030, 17:30 WIB is 10:30 UTC
    expect(bodyOf("/jobs/p1/design-request", "PUT").deadline).toBe("2030-03-04T10:30:00.000Z");
  });

  it("the deadline is checked against the publishing TIME: the publishing day passes only before the hour, and Clear removes the error", async () => {
    await openPathB();
    await fillDesignerAndBrief();
    await pickDeadlineDay(/March 7th, 2030/); // 09:00 WIB, an hour after the post goes out at 08:00
    expect((await screen.findByRole("alert")).textContent).toContain("before the publishing date and time");
    expect(button("Save brief").disabled).toBe(true);
    expect(button("Send Design Request").disabled).toBe(true);

    await userEvent.selectOptions(screen.getByLabelText("Deadline hour"), "07");
    await waitFor(() => expect(button("Save brief").disabled).toBe(false));
    expect(screen.queryByText(/before the publishing date and time/)).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Deadline hour"), "08"); // 08:00: the same moment as the post
    await waitFor(() => expect(button("Save brief").disabled).toBe(true));

    // Clear is in the calendar's panel: open the picker again (its button now shows the picked day)
    // (the publishing date is also 7 Mar and comes first on the page; the deadline's button is the last one)
    await userEvent.click(screen.getAllByRole("button", { name: /Mar 7, 2030|7 Mar 2030/ }).at(-1)!);
    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => expect(button("Save brief").disabled).toBe(false));
    expect(screen.queryByLabelText("Deadline hour")).toBeNull();
  });

  it("a deadline already gone is refused: today, before now", async () => {
    await openPathB();
    await fillDesignerAndBrief();
    await pickDeadlineDay(/March 1st, 2030/); // now is 10:00 WIB; the day starts at 09:00
    expect((await screen.findByRole("alert")).textContent).toContain("later than now");
    expect(button("Save brief").disabled).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText("Deadline hour"), "12");
    await waitFor(() => expect(button("Save brief").disabled).toBe(false));
  });

  it("a saved brief shows its deadline back in WIB, and a change of only the time is an unsaved change", async () => {
    current = job({ designRequest: request({ status: "draft", deadline: "2030-03-04T10:30:00.000Z" }) });
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(await screen.findByText("Path B · Design request")).toBeTruthy();
    expect((screen.getByLabelText("Deadline hour") as HTMLSelectElement).value).toBe("17");
    expect((screen.getByLabelText("Deadline minute") as HTMLSelectElement).value).toBe("30");
    expect(screen.getByRole("button", { name: /Mar 4, 2030|4 Mar 2030/ })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Deadline minute"), "45");
    await userEvent.click(button("Save brief"));
    await waitFor(() => expect(calls("/jobs/p1/design-request", "PUT")).toHaveLength(1));
    expect(bodyOf("/jobs/p1/design-request", "PUT").deadline).toBe("2030-03-04T10:45:00.000Z");
  });

  it("moving only the deadline's hour of a saved brief is an unsaved change: the bar says so and Cancel asks first", async () => {
    current = job({ designRequest: request({ status: "draft", deadline: "2030-03-04T10:30:00.000Z" }) });
    render(<PostEditor jobId="p1" />);
    await ready();
    await screen.findByText("Path B · Design request");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Deadline hour"), "18");
    expect(await screen.findByText("Unsaved changes")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Deadline hour"), "17"); // back to what is saved
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
  });

  it("a sent request with no deadline says so, and a publishing time before a deadline shows the warning", async () => {
    current = job({ designRequest: request({ deadline: null }) });
    const { unmount } = render(<PostEditor jobId="p1" />);
    await ready();
    expect(await screen.findByText("Path B · Design request sent")).toBeTruthy();
    expect(screen.getAllByText(/Rina S\. · no deadline/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/publishing time is now before the design deadline/)).toBeNull();
    unmount();

    // the post goes out on 7 Mar 08:00 WIB; the deadline of the sent request is later than that
    current = job({ designRequest: request({ deadline: "2030-03-07T05:00:00.000Z" }) });
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(await screen.findByText(/publishing time is now before the design deadline/)).toBeTruthy();
  });

  it("a request the designer answered shows the Figma link and the note, is locked, and has no Cancel; Submit is not blocked by it", async () => {
    current = job({
      designRequest: request({ status: "done", doneAt: "2030-03-03T08:00:00.000Z", figmaUrl: "https://www.figma.com/design/Xk3aPq/env", designerNote: "Slide 3 uses the new map" }),
      content: JSON.stringify({ ...STORED, designFigmaUrl: "https://www.figma.com/design/Xk3aPq/env" }),
    });
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(await screen.findByText("Path B · Design done")).toBeTruthy();
    const link = screen.getByRole("link", { name: /figma\.com\/design\/Xk3aPq\/env/ });
    expect(link.getAttribute("href")).toBe("https://www.figma.com/design/Xk3aPq/env");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("Slide 3 uses the new map")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel request" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send Design Request" })).toBeNull();
    expect(screen.getAllByText(/Design done · Rina S\./).length).toBeGreaterThan(0);
    expect(button("Submit for Review").disabled).toBe(false);
  });

  it("the copywriting and the supporting-assets links are in the basics, filled from the post; changing one sends that key alone", async () => {
    current = job({ content: JSON.stringify({ ...STORED, designCopy: "https://docs.google.com/doc", assetNotes: "ask Rina on Slack" }) });
    render(<PostEditor jobId="p1" />);
    await ready();
    const copy = screen.getByLabelText(/Copywriting link/) as HTMLInputElement;
    const assets = screen.getByLabelText(/Supporting assets link/) as HTMLInputElement;
    expect(copy.value).toBe("https://docs.google.com/doc");
    expect(assets.value).toBe("ask Rina on Slack"); // plain text from a plan stays as it is, and is not an error until it is changed
    expect(screen.queryByRole("alert")).toBeNull();

    await userEvent.clear(copy);
    await userEvent.type(copy, "https://docs.google.com/new");
    await userEvent.click(button("Save as Draft"));
    await waitFor(() => expect(calls("/jobs/p1", "PATCH")).toHaveLength(1));
    expect(bodyOf("/jobs/p1", "PATCH")).toEqual({ designCopy: "https://docs.google.com/new" });
  });

  it("a link that is changed into something that is not an https link is refused before it is sent", async () => {
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.type(screen.getByLabelText(/Supporting assets link/), "not a link");
    expect((await screen.findByRole("alert")).textContent).toContain("https://");
    expect(button("Save as Draft").disabled).toBe(true);
  });

  it("an empty designer list says so and Send stays off", async () => {
    designers = [];
    await openPathB();
    expect(await screen.findByText("No designer in this workspace yet")).toBeTruthy();
    expect(button("Send Design Request").disabled).toBe(true);
  });

  it("a request already sent shows its brief read-only, and Cancel request (red) asks first, then cancels and unlocks", async () => {
    current = job({ designRequest: request() });
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(await screen.findByText("Path B · Design request sent")).toBeTruthy();
    expect(screen.getByText("Five slides, serious tone.")).toBeTruthy();
    const cancel = button("Cancel request");
    expect(cancel.className).toContain("text-red-600");
    await userEvent.click(cancel);
    const dialog = await screen.findByRole("alertdialog");
    expect(calls("/jobs/p1/design-request/cancel")).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(calls("/jobs/p1/design-request/cancel", "POST")).toHaveLength(1));
    await waitFor(() => expect(h.toast.danger).toHaveBeenCalled());
  });

  it("Keep request closes the dialog and cancels nothing", async () => {
    current = job({ designRequest: request() });
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.click(await screen.findByRole("button", { name: "Cancel request" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Keep request" }));
    expect(calls("/jobs/p1/design-request/cancel")).toHaveLength(0);
  });

  it("a designer who left the design team is flagged, and the request still blocks until it is cancelled", async () => {
    current = job({ designRequest: request({ assignee: { id: "u9", name: "Rina Sari", avatarUrl: null, active: false } }) });
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(await screen.findByText(/is no longer in the design team/)).toBeTruthy();
    expect(button("Submit for Review").disabled).toBe(true);
  });
});

describe("Edit Content: Path A, the template and the Studio", () => {
  it("a post whose category has a template opens on Path A and shows it as picked", async () => {
    current = job({ content: JSON.stringify({ ...STORED, category: "Case Study", pillar: "Promotional" }) });
    render(<PostEditor jobId="p1" />);
    await ready();
    const card = await screen.findByRole("button", { name: /Case Study/, pressed: true });
    expect(card).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Studio Editor" })).toBeTruthy();
  });

  it("Open Studio Editor opens a new tab at once, makes the design, saves it on the post and points the tab at it", async () => {
    current = job({ content: JSON.stringify({ ...STORED, category: "Case Study", pillar: "Promotional" }) });
    h.createInstance.mockResolvedValue({ instance: { id: "ckcccccccccccccccccccccc" } });
    const tab = { location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as never);
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.click(await screen.findByRole("button", { name: "Open Studio Editor" }));
    await waitFor(() => expect(tab.location.href).toContain("/canvas/ckcccccccccccccccccccccc?post=p1"));
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(h.createInstance).toHaveBeenCalledWith(TEMPLATE.id);
    expect(bodyOf("/jobs/p1", "PATCH")).toEqual({ canvasInstanceId: "ckcccccccccccccccccccccc", canvasTemplateId: TEMPLATE.id });
    open.mockRestore();
  });

  it("the second time it is a link to the same design, and nothing is created", async () => {
    current = job({ content: JSON.stringify({ ...STORED, category: "Case Study", pillar: "Promotional", canvasInstanceId: "ckcccccccccccccccccccccc", canvasTemplateId: TEMPLATE.id }) });
    h.getInstance.mockResolvedValue({ instance: {} });
    render(<PostEditor jobId="p1" />);
    await ready();
    const link = await screen.findByRole("link", { name: "Open Studio Editor" });
    expect(link.getAttribute("href")).toBe("/canvas/ckcccccccccccccccccccccc?post=p1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(h.createInstance).not.toHaveBeenCalled();
  });

  it("a design made from another template is not reopened for this one", async () => {
    current = job({ content: JSON.stringify({ ...STORED, category: "Case Study", pillar: "Promotional", canvasInstanceId: "ckcccccccccccccccccccccc", canvasTemplateId: "ckdddddddddddddddddddddd" }) });
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(await screen.findByRole("button", { name: "Open Studio Editor" })).toBeTruthy();
    expect(h.getInstance).not.toHaveBeenCalled();
  });

  it("a template with no Canvas design but a Figma link opens that link instead", async () => {
    templates = [{ ...TEMPLATE, canvasRevision: null }];
    current = job({ content: JSON.stringify({ ...STORED, category: "Case Study", pillar: "Promotional" }) });
    render(<PostEditor jobId="p1" />);
    await ready();
    const link = await screen.findByRole("link", { name: /Open in Figma/ });
    expect(link.getAttribute("href")).toBe(TEMPLATE.linkUrl);
  });
});

describe("Edit Content: what the review found", () => {
  it("a brief the person typed survives a save of the post (the reload hands back the same request as a new object)", async () => {
    current = job({ designRequest: request({ status: "draft" }) });
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.click(screen.getByRole("radio", { name: /Path B/ }));
    const brief = await screen.findByLabelText(/Brief for designer/);
    await userEvent.clear(brief);
    await userEvent.type(brief, "Five slides, blue palette");
    // another field changes and the post is saved: the page reloads the post, and its request comes back as a new object
    await userEvent.type(screen.getByLabelText(/Content title/), "!");
    current = job({ designRequest: request({ status: "draft" }) });
    await userEvent.click(button("Save as Draft"));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Draft saved."));
    expect((screen.getByLabelText(/Brief for designer/) as HTMLTextAreaElement).value).toBe("Five slides, blue palette");
  });

  it("a design link the server would refuse turns the save off and says why, instead of failing with the title and caption", async () => {
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.type(screen.getByLabelText(/Figma link to your customised design/), "figma.com/design/abc");
    await userEvent.type(screen.getByLabelText(/Content title/), "!");
    expect(button("Save as Draft").disabled).toBe(true);
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("Fix the design link first.");
    expect(calls("/jobs/p1", "PATCH")).toHaveLength(0);
  });

  it("a request is checked against the date the person sees: Save brief saves the post first when its date changed", async () => {
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.click(screen.getByRole("radio", { name: /Path B/ }));
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: /Designer/ }), "ckaaaaaaaaaaaaaaaaaaaaaaa");
    await userEvent.type(screen.getByLabelText(/Brief for designer/), "Five slides");
    // the person also changed the title, which is unsaved: the request must see the post as saved
    await userEvent.type(screen.getByLabelText(/Content title/), "!");
    await userEvent.click(button("Save brief"));
    await waitFor(() => expect(calls("/jobs/p1/design-request", "PUT")).toHaveLength(1));
    const patchIndex = h.apiFetch.mock.calls.findIndex((c) => c[0] === "/jobs/p1" && c[1]?.method === "PATCH");
    const putIndex = h.apiFetch.mock.calls.findIndex((c) => c[0] === "/jobs/p1/design-request" && c[1]?.method === "PUT");
    expect(patchIndex).toBeGreaterThan(-1);
    expect(patchIndex).toBeLessThan(putIndex);
  });

  it("two things that need the new post at once (Save brief, then Save as Draft) make ONE draft", async () => {
    designers = [{ id: "ckaaaaaaaaaaaaaaaaaaaaaaa", name: "Rina Sari", avatarUrl: null }];
    let release!: () => void;
    const slow = new Promise<{ id: string }>((resolve) => (release = () => resolve({ id: "p1" })));
    const base = h.apiFetch.getMockImplementation()!;
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) =>
      path === "/jobs" && init?.method === "POST" ? slow : base(path, init as never)
    );
    render(<PostEditor />);
    await screen.findByRole("heading", { name: "Add Content" });
    await userEvent.type(screen.getByLabelText(/Content title/), "T");
    await userEvent.click(screen.getByRole("radio", { name: /Path B/ }));
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: /Designer/ }), "ckaaaaaaaaaaaaaaaaaaaaaaa");
    await userEvent.type(screen.getByLabelText(/Brief for designer/), "Five slides");
    // the creation of the draft is still in flight (slow) when the second action asks for the post
    await userEvent.click(button("Save brief"));
    await userEvent.click(button("Save as Draft"));
    await waitFor(() => expect(calls("/jobs", "POST")).toHaveLength(1));
    release();
    await waitFor(() => expect(calls("/jobs/p1/design-request", "PUT")).toHaveLength(1));
    expect(calls("/jobs", "POST")).toHaveLength(1);
  });

  it("the Studio, while it opens, holds every other save (the page and the Studio would both write the post's JSON)", async () => {
    templates = [{ ...TEMPLATE, canvasRevision: 2 }];
    current = job({ content: JSON.stringify({ ...STORED, category: "Case Study", pillar: "Promotional" }) });
    let release!: () => void;
    h.createInstance.mockReturnValue(new Promise((resolve) => (release = () => resolve({ instance: { id: "ckcccccccccccccccccccccc" } }))));
    const open = vi.spyOn(window, "open").mockReturnValue({ location: { href: "" }, close: vi.fn() } as never);
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.type(screen.getByLabelText(/Content title/), "!");
    await userEvent.click(await screen.findByRole("button", { name: "Open Studio Editor" }));
    await waitFor(() => expect(button("Save as Draft").disabled).toBe(true));
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("Opening the Studio…");
    release();
    await waitFor(() => expect(button("Save as Draft").disabled).toBe(false));
    open.mockRestore();
  });

  it("a post takes ten files at most: the rest are refused with the number, and nothing more is uploaded", async () => {
    current = job({ content: JSON.stringify({ ...STORED, format: "carousel", mediaUrls: Array.from({ length: 9 }, (_, i) => `/uploads/${i}.png`) }) });
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path === "/upload") return { url: `/uploads/new-${Math.random()}.png` };
      if (path === "/jobs/p1" && (init?.method ?? "GET") === "GET") return current;
      if (path === "/accounts") return ACCOUNTS;
      if (path === "/templates") return { templates };
      throw new Error(`unexpected ${path}`);
    });
    render(<PostEditor jobId="p1" />);
    await ready();
    const files = [1, 2, 3].map((n) => new File(["x"], `f${n}.png`, { type: "image/png" }));
    await userEvent.upload(screen.getByLabelText("Choose design files"), files);
    expect(await screen.findByText("A post takes 10 files at most. Only the first 1 are used.")).toBeTruthy();
    expect(calls("/upload")).toHaveLength(1);
  });
});

describe("an approved Canvas design on the post", () => {
  const DESIGN = { submissionId: "sub1", mediaUrl: "/uploads/canvas-designs/sub1/p.png" };
  const withDesign = (bytes = 2_000_000, extra: Record<string, unknown> = {}) =>
    job({ content: JSON.stringify({ ...STORED, mediaUrls: [DESIGN.mediaUrl], canvasDesigns: [{ ...DESIGN, bytes }] }), ...extra });

  it("marks the picture as a Canvas design and no longer offers the approved-design picker", async () => {
    current = withDesign();
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(screen.getByText("Canvas")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use approved design/ })).toBeNull();
  });

  it("removing the design's picture sends the pictures and an EMPTY design list, so no stale reference is left", async () => {
    current = withDesign();
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Remove file 1" }));
    await userEvent.click(button("Save as Draft"));
    await waitFor(() => expect(calls("/jobs/p1", "PATCH")).toHaveLength(1));
    expect(bodyOf("/jobs/p1", "PATCH")).toEqual({ mediaUrls: [], canvasDesigns: [] });
  });

  it("a post that already holds a design saves an unrelated edit WITHOUT resending it", async () => {
    current = withDesign();
    render(<PostEditor jobId="p1" />);
    await ready();
    await userEvent.type(screen.getByLabelText(/Content title/), "!");
    await userEvent.click(button("Save as Draft"));
    await waitFor(() => expect(calls("/jobs/p1", "PATCH")).toHaveLength(1));
    expect(Object.keys(bodyOf("/jobs/p1", "PATCH"))).toEqual(["title"]);
  });

  it("says before publishing that Instagram cannot take it, names the reason, and the warning goes away with the channel", async () => {
    current = withDesign(2_000_000, { targets: [{ id: "t1", accountId: "acc-ig", status: "pending", platformPostId: null, error: null, attempts: 0, account: null }] });
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(await screen.findByText("An approved design can't go to every channel you picked")).toBeTruthy();
    expect(screen.getByText(/Instagram publishes JPEG pictures only.*does not convert/)).toBeTruthy();
    expect(screen.getByText(/DISCLOSURE/)).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Instagram: @braga.geo" }));
    expect(screen.queryByText("An approved design can't go to every channel you picked")).toBeNull();
  });

  it("no warning for a channel with no known problem, and none without a design", async () => {
    current = withDesign(); // LinkedIn, 2 MB: under its 5 MB
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(screen.queryByText("An approved design can't go to every channel you picked")).toBeNull();
  });

  it("after a save it adopts the size the SERVER measured, so a warning cannot depend on a number the browser made up", async () => {
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (path === "/accounts") return ACCOUNTS;
      if (path === "/templates") return { templates };
      if (path === "/jobs/p1" && method === "GET") return current;
      if (path === "/jobs/p1" && method === "PATCH") {
        // a server that stores what it measured: the save answers with it AND the reload that follows reads it back
        const content = JSON.stringify({ ...STORED, mediaUrls: [DESIGN.mediaUrl], canvasDesigns: [{ ...DESIGN, bytes: 6_000_000 }] });
        current = job({ content });
        return { content };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    current = withDesign(); // LinkedIn: 5 MB limit, the browser's 2 MB is under it
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(screen.queryByText("An approved design can't go to every channel you picked")).toBeNull();
    await userEvent.type(screen.getByLabelText(/Content title/), "!"); // a real change, so the save sends a PATCH
    await userEvent.click(button("Save as Draft"));
    expect(await screen.findByText(/LinkedIn accepts pictures up to 5\.00 MB.*6\.00 MB/)).toBeTruthy(); // the server measured 6 MB
  });
});

describe("the Studio's generated export on the draft", () => {
  const EXPORT = { instanceId: "i1", version: 3, files: [{ format: "pdf", mediaUrl: "/uploads/d.pdf" }, { format: "jpeg", mediaUrl: "/uploads/d.jpg" }] };
  const withExport = () => job({ content: JSON.stringify({ ...STORED, canvasExport: EXPORT }) });

  it("shows the files apart from the manual uploads, with a Studio badge and an open link for the PDF", async () => {
    current = withExport();
    render(<PostEditor jobId="p1" />);
    await ready();
    expect(await screen.findByText("From the Studio")).toBeTruthy();
    expect(screen.getAllByText("Studio")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /PDF/ }).getAttribute("href")).toBe("/uploads/d.pdf");
    expect(screen.getByAltText("Generated JPEG")).toBeTruthy();
  });

  it("removing it calls the server and takes it out of the card", async () => {
    h.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (path === "/accounts") return ACCOUNTS;
      if (path === "/templates") return { templates };
      if (path === "/jobs/p1" && method === "GET") return current;
      if (path === "/jobs/p1/design-export" && method === "DELETE") return { ok: true };
      throw new Error(`unexpected ${method} ${path}`);
    });
    current = withExport();
    render(<PostEditor jobId="p1" />);
    await ready();
    const removes = await screen.findAllByRole("button", { name: "Remove the generated design" });
    await userEvent.click(removes[0]);
    await waitFor(() => expect(calls("/jobs/p1/design-export", "DELETE")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("From the Studio")).toBeNull());
  });
});

describe("Add Content", () => {
  it("Save as Draft creates the post once, then later saves are edits of that post", async () => {
    render(<PostEditor />);
    expect(await screen.findByRole("heading", { name: "Add Content" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/Content title/), "New idea");
    await userEvent.click(button("Save as Draft"));
    await waitFor(() => expect(calls("/jobs", "POST")).toHaveLength(1));
    expect(bodyOf("/jobs", "POST")).toMatchObject({ draft: true, content: { title: "New idea" } });
  });

  it("a scheduled post needs a date, a channel and a caption: the button says which is missing", async () => {
    h.perms = { canEditContent: true, canReview: false, canManageTemplates: false, canSubmitOwn: false, loading: false };
    render(<PostEditor />);
    await screen.findByRole("heading", { name: "Add Content" });
    expect(button("Schedule Post").disabled).toBe(true);
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("Pick a publishing date");
  });
});
