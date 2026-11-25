// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
  replace: vi.fn(),
  role: "member" as string,
  workspaceName: "Braga Tech",
  /** The other workspaces of the person: [name, role]. */
  others: [] as [string, string][],
  hasPassword: true,
  user: null as null | Record<string, unknown>,
  /** What the browser reads as the size of the chosen picture (jsdom has no createImageBitmap); null = not a picture it can read */
  photoSize: { width: 800, height: 600 } as null | { width: number; height: number },
  toast: { toast: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch, assetUrl: (u: string) => u }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: h.user, refresh: h.refresh, logout: h.logout }) }));
vi.mock("@/context/WorkspaceContext", () => ({
  useWorkspace: () => {
    const active = { id: "ws-1", name: h.workspaceName, role: h.role, plan: "pro", joinedAt: "2026-11-13T03:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" };
    return { activeWorkspace: active, workspaces: [active, ...h.others.map(([name, role], i) => ({ id: `ws-o${i}`, name, role }))] };
  },
}));
vi.mock("@/components/Toast", () => ({ useToast: () => h.toast }));
vi.mock("@/lib/profile-photo", async (orig) => ({ ...(await orig<typeof import("@/lib/profile-photo")>()), readPhotoSize: async () => h.photoSize }));
vi.mock("@/components/TrialUrgentBanner", () => ({ TrialUrgentBanner: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace, push: vi.fn() }), usePathname: () => "/profile" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/lib/useNotifications", () => ({
  useNotifications: () => ({ unread: 0, items: null, loading: false, error: null, load: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn() }),
}));

import ProfilePage from "./page";

const ACCOUNTS = [
  { id: "a1", platform: "linkedin", displayName: "Braga Geo" },
  { id: "a2", platform: "instagram", displayName: "@braga.geo" },
];

const NOW = new Date("2026-11-17T05:00:00Z"); // 12:00 WIB on 17 Nov 2026

/** What /user/devices answers: this device, another one, and the sign-ins. */
const DEVICES = {
  devices: [
    { id: "s-this", tile: "Mac", name: "Chrome on macOS", startedAt: "2026-11-17T03:00:00.000Z", lastActiveAt: "2026-11-17T04:58:00.000Z", current: true },
    { id: "s-phone", tile: "iOS", name: "Safari on iOS", startedAt: "2026-11-16T01:00:00.000Z", lastActiveAt: "2026-11-17T02:00:00.000Z", current: false },
  ],
  days: 30,
  signIns: [
    { id: "e1", at: "2026-11-17T01:12:00.000Z", device: "Chrome on macOS", failure: null },
    { id: "e2", at: "2026-11-16T12:40:00.000Z", device: "Firefox on Linux", failure: "Wrong password" },
    { id: "e3", at: "2026-11-10T15:05:00.000Z", device: "Edge on Windows", failure: null },
  ],
};

const ACTIVITY = {
  quarter: "Q4 2026",
  kind: "maker",
  rows: [
    { id: "imported", count: 60 },
    { id: "sent", count: 12 },
    { id: "approved", count: 8 },
    { id: "scheduled", count: 2 },
    { id: "published", count: 1, channels: ["instagram"] },
  ],
};

/** The answers of the page's requests; a test replaces one to try another case. */
const answers: Record<string, unknown> = {};

/** What the page's own requests get, unless a test says otherwise. */
function base(path: string, accounts: unknown = ACCOUNTS): unknown {
  if (path in answers) {
    const a = answers[path];
    if (a instanceof Error) throw a;
    return a;
  }
  if (path === "/accounts") return accounts;
  if (path === "/user/devices") return DEVICES;
  if (path === "/user/activity") return ACTIVITY;
  if (path === "/user/two-step") return { enabled: false, enabledAt: null, recoveryLeft: 0, available: true };
  return { ok: true };
}

function serve(accounts: unknown = ACCOUNTS) {
  h.apiFetch.mockImplementation(async (path: string) => base(path, accounts));
}

const calls = (path: string) => h.apiFetch.mock.calls.filter(([p]) => p === path);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const k of Object.keys(answers)) delete answers[k];
  h.role = "member";
  h.workspaceName = "Braga Tech";
  h.others = [];
  h.hasPassword = true;
  h.user = { id: "u1", name: "Puteri A.", email: "puteri@braga.geo", avatarUrl: null, role: "member", hasPassword: true };
  h.photoSize = { width: 800, height: 600 };
  h.refresh.mockResolvedValue(undefined);
  h.logout.mockResolvedValue(undefined);
  serve();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const nameField = () => screen.getByRole("textbox", { name: /Full name/ }) as HTMLInputElement;

describe("My Profile: what it shows", () => {
  it("puts the person's own data on the page, from the session and the workspace", async () => {
    render(<ProfilePage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("My Profile");
    expect(nameField().value).toBe("Puteri A.");
    expect((screen.getByRole("textbox", { name: /Work email/ }) as HTMLInputElement).value).toBe("puteri@braga.geo");
    expect(screen.getByText("Role: Marketing")).toBeTruthy();
    expect(screen.getByText("Pro plan · annual")).toBeTruthy();
    expect(screen.getByText("Member since 13 Nov 2026 · active now")).toBeTruthy();
    expect(screen.getByText("Marketing Lead · Braga Tech")).toBeTruthy();
    expect(screen.getAllByText("puteri@braga.geo").length).toBeGreaterThan(0);
    expect(await screen.findByText("Braga Geo · connected")).toBeTruthy();
  });

  it("the role is a read-only box, and the work email cannot be edited", () => {
    render(<ProfilePage />);
    const box = screen.getByText("Role · set by admin").closest("div")!;
    expect(box.querySelector("input, select, textarea")).toBeNull();
    expect((screen.getByRole("textbox", { name: /Work email/ }) as HTMLInputElement).readOnly).toBe(true);
  });

  it("Role & permissions comes from the role's profile", () => {
    render(<ProfilePage />);
    const card = screen.getByRole("heading", { name: "Role & permissions" }).closest("[data-slot=card]") as HTMLElement;
    expect(within(card).getByText("Marketing")).toBeTruthy();
    expect(within(card).getByText("Marketing · Braga Tech")).toBeTruthy();
    expect(within(card).getByText("Design Team · Dewi W.")).toBeTruthy();
    expect(within(card).getByText("Import plans, create posts, approve, schedule and publish")).toBeTruthy();
    expect(within(card).getByText("Create, edit or publish templates")).toBeTruthy();
    expect(screen.getAllByText("Approves & publishes").length).toBe(2); // the strip and the profile card
  });

  it("another role changes the words and not the markup", () => {
    h.role = "designer";
    render(<ProfilePage />);
    expect(screen.getByText("Role: Design team")).toBeTruthy();
    expect(screen.getAllByText("Makes the designs").length).toBeGreaterThan(0);
    expect(screen.queryByText("Approves & publishes")).toBeNull();
    expect(screen.getByText("Marketing Team")).toBeTruthy();
  });

  it("the Marketing sample (job, about, team, contact) is shown to Marketing only", () => {
    h.role = "designer";
    render(<ProfilePage />);
    expect(screen.queryByText(/Marketing Lead/)).toBeNull();
    expect((screen.getByRole("textbox", { name: /About you/ }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("Designer · Braga Tech")).toBeTruthy();
    expect(screen.getByText("Design · Braga Tech")).toBeTruthy();
    expect(screen.queryByText(/Dewi W\./)).toBeNull();
  });

  it("lists the accounts of the workspace, each ticked, and shows their platforms in the strip", async () => {
    render(<ProfilePage />);
    const linkedin = await screen.findByRole("checkbox", { name: "LinkedIn, Braga Geo" });
    expect(linkedin.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "Instagram, @braga.geo" }).getAttribute("aria-checked")).toBe("true");
    expect(within(screen.getByRole("list", { name: "Connected platforms" })).getAllByRole("listitem")).toHaveLength(2);
    await userEvent.click(linkedin);
    expect(linkedin.getAttribute("aria-checked")).toBe("false");
    expect(within(screen.getByRole("list", { name: "Connected platforms" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("two accounts of one platform are two different checkboxes", async () => {
    serve([...ACCOUNTS, { id: "a3", platform: "instagram", displayName: "@braga.shop" }]);
    render(<ProfilePage />);
    expect(await screen.findByRole("checkbox", { name: "Instagram, @braga.geo" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Instagram, @braga.shop" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Instagram" })).toBeNull();
  });

  it("says so when there is no account, or the accounts cannot be read", async () => {
    serve([]);
    render(<ProfilePage />);
    expect(await screen.findByText("No accounts are connected to this workspace yet.")).toBeTruthy();
    cleanup();
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path === "/accounts") throw new Error("boom");
      return base(path);
    });
    render(<ProfilePage />);
    expect(await screen.findByText("No accounts are connected to this workspace yet.")).toBeTruthy();
  });

  it("counts the About text as it is typed, up to 300", async () => {
    render(<ProfilePage />);
    const about = screen.getByRole("textbox", { name: /About you/ }) as HTMLTextAreaElement;
    expect(screen.getByText(/132 \/ 300 characters/)).toBeTruthy();
    await userEvent.clear(about);
    await userEvent.type(about, "Hello");
    expect(screen.getByText(/5 \/ 300 characters/)).toBeTruthy();
    expect(about.maxLength).toBe(300);
  });

  it("states the password rule of the app, not the design's 12", () => {
    render(<ProfilePage />);
    expect(screen.getByText("Use at least 8 characters with a number")).toBeTruthy();
    expect(screen.queryByText(/12 characters/)).toBeNull();
  });

  it("the delete text says what really happens: it names every workspace that goes with the account", async () => {
    const { unmount } = render(<ProfilePage />);
    expect(screen.getByText(/Other people's posts and plans stay in the Braga Tech workspace/)).toBeTruthy();
    unmount();
    // a Marketing member of Braga Tech who also owns a personal workspace of their own
    h.others = [["Putri's workspace", "owner"]];
    render(<ProfilePage />);
    expect(screen.getByText(/the workspaces you own \(Putri's workspace\) with everything in them/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    expect((await screen.findByRole("alertdialog")).textContent).toMatch(/workspaces you own, with everything in them: Putri's workspace/);
  });

  it("an owner of the active workspace sees it named too", () => {
    h.role = "owner";
    render(<ProfilePage />);
    expect(screen.getByText(/the workspaces you own \(Braga Tech\) with everything in them/)).toBeTruthy();
  });
});

describe("My Profile: in production the sample is left out", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("shows only what the app knows: no second step, no made-up dates; the devices and the activity are real, so they stay", async () => {
    vi.stubEnv("NODE_ENV", "production");
    render(<ProfilePage />);
    expect(await screen.findByText("Devices & login history")).toBeTruthy();
    expect(await screen.findByText("Chrome on macOS", { selector: "p" })).toBeTruthy();
    expect(await screen.findByText("Posts imported")).toBeTruthy();
    // two-step verification is real now: its row is there in production too, and says what the API says
    expect(await screen.findByText("Two-step verification")).toBeTruthy();
    expect(screen.queryByText(/Last changed/)).toBeNull();
    expect(screen.queryByText(/annual/)).toBeNull();
    expect(screen.queryByText(/Dewi W\./)).toBeNull();
    expect(screen.queryByText(/Marketing lead for Braga Geo/)).toBeNull();
  });

  it("still shows the real parts, and the plan without an interval it does not know", () => {
    vi.stubEnv("NODE_ENV", "production");
    render(<ProfilePage />);
    expect(nameField().value).toBe("Puteri A.");
    expect(screen.getByText("Pro plan")).toBeTruthy();
    expect(screen.getByText("Role: Marketing")).toBeTruthy();
    expect(screen.getByText("Password recovery")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete account" })).toBeTruthy();
    expect(screen.getByText("Marketing · Braga Tech", { selector: "p" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: /About you/ }) as HTMLTextAreaElement).value).toBe("");
  });

  it("the page still has no dangling dot or double space", async () => {
    vi.stubEnv("NODE_ENV", "production");
    render(<ProfilePage />);
    await screen.findByText("Posts imported");
    for (const el of document.querySelectorAll("p, dd")) {
      expect(el.textContent ?? "", el.outerHTML).not.toMatch(/·\s*$/);
      expect(el.textContent ?? "", el.outerHTML).not.toMatch(/ {2}/);
    }
  });
});

describe("My Profile: Save and Cancel", () => {
  it("saves the name for real, and only the name", async () => {
    render(<ProfilePage />);
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Puteri Anggraini");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls("/user/profile")).toHaveLength(1));
    expect(calls("/user/profile")[0][1]).toEqual({ method: "PATCH", body: JSON.stringify({ name: "Puteri Anggraini" }) });
    expect(h.refresh).toHaveBeenCalled();
    expect(h.toast.success).toHaveBeenCalledWith("Name saved");
  });

  it("the name and the sample fields together: it says the rest stays on this page", async () => {
    render(<ProfilePage />);
    await userEvent.type(nameField(), "x");
    await userEvent.click(screen.getByRole("checkbox", { name: "Weekly report" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Name saved. Your other changes stay on this page for now"));
    expect(calls("/user/profile")).toHaveLength(1);
  });

  it("changes that the server does not keep yet send nothing, and do not say they are saved", async () => {
    render(<ProfilePage />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Weekly report" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Saved on this page only for now"));
    expect(h.toast.success).not.toHaveBeenCalledWith("Name saved");
    expect(calls("/user/profile")).toHaveLength(0);
  });

  it("the name field has a length limit", () => {
    render(<ProfilePage />);
    expect(nameField().maxLength).toBe(100);
  });

  it("with nothing changed, Save says so and sends nothing", async () => {
    render(<ProfilePage />);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(h.toast.toast).toHaveBeenCalledWith("No changes to save");
    expect(calls("/user/profile")).toHaveLength(0);
  });

  it("an empty name is refused before any request", async () => {
    render(<ProfilePage />);
    await userEvent.clear(nameField());
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(h.toast.error).toHaveBeenCalledWith("Enter your full name");
    expect(nameField().getAttribute("aria-invalid")).toBe("true");
    expect(calls("/user/profile")).toHaveLength(0);
    await userEvent.type(nameField(), "P");
    expect(nameField().getAttribute("aria-invalid")).toBeNull();
  });

  it("a name of only spaces is empty too", async () => {
    render(<ProfilePage />);
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(calls("/user/profile")).toHaveLength(0);
  });

  it("a server error is shown and the form keeps what was typed", async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path === "/user/profile") throw new Error("Name is too long");
      return base(path);
    });
    render(<ProfilePage />);
    await userEvent.type(nameField(), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Name is too long"));
    expect(nameField().value).toBe("Puteri A.x");
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it("without a workspace name the page prints no dangling dot and no double space", () => {
    h.workspaceName = "";
    render(<ProfilePage />);
    expect(screen.getByText("Marketing Lead")).toBeTruthy();
    expect(screen.getByText(/stay in your workspace/)).toBeTruthy();
    for (const el of document.querySelectorAll("p, dd")) {
      expect(el.textContent ?? "", el.outerHTML).not.toMatch(/·\s*$/);
      expect(el.textContent ?? "", el.outerHTML).not.toMatch(/ {2}/);
    }
  });

  it("Cancel puts back what the page started with", async () => {
    render(<ProfilePage />);
    await userEvent.type(nameField(), " Z");
    await userEvent.click(screen.getByRole("checkbox", { name: "Weekly report" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(nameField().value).toBe("Puteri A.");
    expect(screen.getByRole("checkbox", { name: "Weekly report" }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("My Profile: the buttons", () => {
  it("opening the page reads only what the page shows: accounts, activity, devices and the two-step state", async () => {
    render(<ProfilePage />);
    await screen.findByText("Two-step verification");
    expect(h.apiFetch.mock.calls.map(([p]) => p).sort()).toEqual(["/accounts", "/user/activity", "/user/devices", "/user/two-step"]);
    expect(h.toast.toast).not.toHaveBeenCalledWith("Not available yet"); // nothing on this page says "not yet" any more
  });

  it("Send reset link mails the account's own email", async () => {
    render(<ProfilePage />);
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(calls("/auth/forgot-password")).toHaveLength(1));
    expect(calls("/auth/forgot-password")[0][1]).toEqual({ method: "POST", body: JSON.stringify({ email: "puteri@braga.geo" }) });
    expect(h.toast.success).toHaveBeenCalledWith("We sent a reset link to puteri@braga.geo");
  });

  it("a failed reset link says why", async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path === "/auth/forgot-password") throw new Error("Too many requests");
      return base(path);
    });
    render(<ProfilePage />);
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Too many requests"));
  });

  it("Log out signs out and goes to the login page", async () => {
    render(<ProfilePage />);
    await userEvent.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login"));
    expect(h.logout).toHaveBeenCalled();
  });
});

describe("My Profile: change password", () => {
  it("opens a dialog, checks the new password on the page, and sends both passwords", async () => {
    render(<ProfilePage />);
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Current password"), "old-pass-1");
    await userEvent.type(within(dialog).getByLabelText("New password"), "short");
    await userEvent.type(within(dialog).getByLabelText("Confirm new password"), "short");
    await userEvent.click(within(dialog).getByRole("button", { name: "Update password" }));
    expect(within(dialog).getByRole("alert").textContent).toMatch(/at least 8 characters/);
    expect(calls("/user/password")).toHaveLength(0);

    await userEvent.clear(within(dialog).getByLabelText("New password"));
    await userEvent.type(within(dialog).getByLabelText("New password"), "new-pass-12");
    await userEvent.click(within(dialog).getByRole("button", { name: "Update password" }));
    expect(within(dialog).getByRole("alert").textContent).toMatch(/don't match/);
    expect(calls("/user/password")).toHaveLength(0);

    await userEvent.clear(within(dialog).getByLabelText("Confirm new password"));
    await userEvent.type(within(dialog).getByLabelText("Confirm new password"), "new-pass-12");
    await userEvent.click(within(dialog).getByRole("button", { name: "Update password" }));
    await waitFor(() => expect(calls("/user/password")).toHaveLength(1));
    expect(calls("/user/password")[0][1]).toEqual({ method: "PATCH", body: JSON.stringify({ currentPassword: "old-pass-1", newPassword: "new-pass-12" }) });
    expect(h.toast.success).toHaveBeenCalledWith("Password changed");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // Changing the password signs the other devices out on the server, so the list on the page must be asked again.
  it("a changed password asks for the device list again: the other devices are gone", async () => {
    render(<ProfilePage />);
    await screen.findByText("Safari on iOS");
    expect(calls("/user/devices")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Current password"), "old-pass-1");
    await userEvent.type(within(dialog).getByLabelText("New password"), "new-pass-12");
    await userEvent.type(within(dialog).getByLabelText("Confirm new password"), "new-pass-12");
    await userEvent.click(within(dialog).getByRole("button", { name: "Update password" }));
    await waitFor(() => expect(calls("/user/devices")).toHaveLength(2));
  });

  it("a wrong current password is shown and the dialog stays open", async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path === "/user/password") throw new Error("Current password is incorrect");
      return base(path);
    });
    render(<ProfilePage />);
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Current password"), "nope");
    await userEvent.type(within(dialog).getByLabelText("New password"), "new-pass-12");
    await userEvent.type(within(dialog).getByLabelText("Confirm new password"), "new-pass-12");
    await userEvent.click(within(dialog).getByRole("button", { name: "Update password" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Current password is incorrect"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(calls("/user/devices")).toHaveLength(1); // nothing changed, so the list is not asked again
  });

  it("what was typed is gone when the dialog is opened again", async () => {
    render(<ProfilePage />);
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    await userEvent.type(within(await screen.findByRole("dialog")).getByLabelText("Current password"), "secret-1");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect((within(await screen.findByRole("dialog")).getByLabelText("Current password") as HTMLInputElement).value).toBe("");
  });

  it("an account without a password is pointed at the reset link instead", async () => {
    h.user = { ...h.user!, hasPassword: false };
    render(<ProfilePage />);
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(h.toast.toast).toHaveBeenCalledWith(expect.stringMatching(/Send reset link/));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("My Profile: delete account", () => {
  async function open() {
    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    return screen.findByRole("alertdialog");
  }

  it("asks for the password, keeps the button off until it is typed, then deletes, signs out and leaves", async () => {
    render(<ProfilePage />);
    const dialog = await open();
    const confirm = within(dialog).getByRole("button", { name: "Delete forever" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText("Your password"), "my-pass-1");
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login"));
    expect(calls("/user")).toHaveLength(1);
    expect(calls("/user")[0][1]).toEqual({ method: "DELETE", body: JSON.stringify({ password: "my-pass-1" }) });
    expect(h.logout).toHaveBeenCalled();
  });

  it("a wrong password is shown, nothing is signed out and the dialog stays", async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path === "/user") throw new Error("Incorrect password");
      return base(path);
    });
    render(<ProfilePage />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("Your password"), "wrong-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete forever" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Incorrect password"));
    expect(h.logout).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("an account without a password must type its email", async () => {
    h.user = { ...h.user!, hasPassword: false };
    render(<ProfilePage />);
    const dialog = await open();
    const confirm = within(dialog).getByRole("button", { name: "Delete forever" }) as HTMLButtonElement;
    const field = within(dialog).getByLabelText("Type puteri@braga.geo to confirm");
    await userEvent.type(field, "someone@else.com");
    expect(confirm.disabled).toBe(true);
    await userEvent.clear(field);
    await userEvent.type(field, "puteri@braga.geo");
    expect(confirm.disabled).toBe(false);
  });

  it("Cancel deletes nothing", async () => {
    render(<ProfilePage />);
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls("/user")).toHaveLength(0);
  });
});

describe("My Profile: devices and login history", () => {
  const card = async () => (await screen.findByRole("heading", { name: "Devices & login history" })).closest("[data-slot=card]") as HTMLElement;

  it("lists the devices the account is open on, this one marked, and when the others were last active", async () => {
    render(<ProfilePage />);
    const c = within(await card());
    expect(await c.findByText("Chrome on macOS", { selector: "p" })).toBeTruthy();
    expect(c.getByText("This device")).toBeTruthy();
    expect(c.getByText("active now")).toBeTruthy();
    expect(c.getByText("Safari on iOS")).toBeTruthy();
    expect(c.getByText("last active 3 hours ago")).toBeTruthy();
  });

  it("the number of days the history covers is the one the API sends, not a number kept on the page", async () => {
    answers["/user/devices"] = { ...DEVICES, days: 14 };
    render(<ProfilePage />);
    expect(within(await card()).getByText("Last 14 days")).toBeTruthy();
  });

  it("only the other devices have a Sign out", async () => {
    render(<ProfilePage />);
    const c = within(await card());
    const current = (await c.findByText("This device")).closest("li")!;
    expect(within(current).queryByRole("button")).toBeNull();
    expect(c.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
  });

  it("recent sign-ins: the time, the device, and whether it worked; a wrong password says so", async () => {
    render(<ProfilePage />);
    const c = within(await card());
    expect(await c.findByText("Today, 08:12 WIB")).toBeTruthy();
    expect(c.getByText("Yesterday, 19:40 WIB")).toBeTruthy();
    expect(c.getByText("Firefox on Linux")).toBeTruthy();
    expect(c.getByText("Wrong password")).toBeTruthy();
    expect(c.getByText("10 Nov 2026, 22:05 WIB")).toBeTruthy();
    expect(c.getAllByText("Successful")).toHaveLength(2);
    expect(c.getByText("Last 30 days")).toBeTruthy();
  });

  it("there is no Location column: the API keeps no address", async () => {
    render(<ProfilePage />);
    const c = within(await card());
    await c.findByText("Today, 08:12 WIB");
    expect(c.queryByText("Location")).toBeNull();
  });

  it("Password & sign-in says when and from what the person last signed in, from the history", async () => {
    render(<ProfilePage />);
    expect(await screen.findByText("Last sign-in today, 08:12 WIB · Chrome on macOS")).toBeTruthy();
  });

  it("the last sign-in that WORKED is the one named, not a wrong password after it", async () => {
    answers["/user/devices"] = { ...DEVICES, signIns: [{ id: "x", at: "2026-11-17T04:00:00.000Z", device: "Firefox on Linux", failure: "Wrong password" }, ...DEVICES.signIns] };
    render(<ProfilePage />);
    expect(await screen.findByText("Last sign-in today, 08:12 WIB · Chrome on macOS")).toBeTruthy();
  });

  it("Sign out ends that device's session, says so, and asks the list again", async () => {
    render(<ProfilePage />);
    const c = within(await card());
    await userEvent.click(await c.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(calls("/user/devices/s-phone")).toHaveLength(1));
    expect(calls("/user/devices/s-phone")[0][1]).toEqual({ method: "DELETE" });
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Signed out of Safari on iOS"));
    await waitFor(() => expect(calls("/user/devices")).toHaveLength(2));
    expect(h.toast.toast).not.toHaveBeenCalled(); // no more "Not available yet"
  });

  it("a Sign out that fails says why, and still asks the list again (the device may already be gone)", async () => {
    answers["/user/devices/s-phone"] = new Error("That device is not signed in any more.");
    render(<ProfilePage />);
    await userEvent.click(await within(await card()).findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("That device is not signed in any more."));
    await waitFor(() => expect(calls("/user/devices")).toHaveLength(2));
  });

  it("Sign out of other devices asks first; Cancel sends nothing", async () => {
    render(<ProfilePage />);
    await userEvent.click(await within(await card()).findByRole("button", { name: "Sign out of other devices" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Sign out of your other devices?")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls("/user/devices/sign-out-others")).toHaveLength(0);
  });

  it("confirming signs every other device out, says so, and asks the list again", async () => {
    render(<ProfilePage />);
    await userEvent.click(await within(await card()).findByRole("button", { name: "Sign out of other devices" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(calls("/user/devices/sign-out-others")).toHaveLength(1));
    expect(calls("/user/devices/sign-out-others")[0][1]).toEqual({ method: "POST" });
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Signed out of your other devices"));
    await waitFor(() => expect(calls("/user/devices")).toHaveLength(2));
  });

  it("a failed sign-out of the others says why and the dialog stays for another try", async () => {
    answers["/user/devices/sign-out-others"] = new Error("Too many requests");
    render(<ProfilePage />);
    await userEvent.click(await within(await card()).findByRole("button", { name: "Sign out of other devices" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Too many requests"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("with only this device, there is nothing to sign out of: the button is off", async () => {
    answers["/user/devices"] = { ...DEVICES, devices: [DEVICES.devices[0]] };
    render(<ProfilePage />);
    const button = await within(await card()).findByRole("button", { name: "Sign out of other devices" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  });

  it("no sign-ins yet says so; and there is no last sign-in line", async () => {
    answers["/user/devices"] = { devices: [DEVICES.devices[0]], days: 30, signIns: [] };
    render(<ProfilePage />);
    expect(await screen.findByText("No sign-ins in the last 30 days.")).toBeTruthy();
    expect(screen.queryByText(/Last sign-in/)).toBeNull();
  });

  it("while it loads there is a skeleton, not the old made-up devices", async () => {
    h.apiFetch.mockImplementation(() => new Promise(() => {}));
    render(<ProfilePage />);
    expect(screen.getByLabelText("Loading your devices").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("MacBook Pro · Chrome on macOS")).toBeNull();
    expect(screen.queryByText("Today, 08:12 WIB")).toBeNull();
  });

  it("when the devices cannot be loaded it says so and offers to try again, and draws no list", async () => {
    answers["/user/devices"] = new Error("Network down");
    render(<ProfilePage />);
    expect(await screen.findByText(/We couldn't load your devices/)).toBeTruthy();
    answers["/user/devices"] = DEVICES;
    const c = within(await card());
    await userEvent.click(c.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("This device")).toBeTruthy();
  });
});

describe("My Profile: your activity", () => {
  const card = async () => (await screen.findByRole("heading", { name: "Your activity" })).closest("[data-slot=card]") as HTMLElement;

  it("shows the numbers the API counted for this person, with what each means", async () => {
    render(<ProfilePage />);
    const c = within(await card());
    expect(await c.findByText("Posts imported")).toBeTruthy();
    expect(c.getByText("60")).toBeTruthy();
    expect(c.getByText("Sent to Design Team")).toBeTruthy();
    expect(c.getByText("12")).toBeTruthy();
    expect(c.getByText("Designs approved")).toBeTruthy();
    expect(c.getByText("Scheduled")).toBeTruthy();
    expect(c.getByText("Published")).toBeTruthy();
    expect(c.getByText("Live on Instagram")).toBeTruthy();
    expect(c.getByText("Q4 2026")).toBeTruthy();
    expect(c.getByText("Counts cover the current quarter and reset on 1 January.")).toBeTruthy();
  });

  it("a quarter with nothing in it says so in every row, not '60 posts from your plan'", async () => {
    answers["/user/activity"] = { quarter: "Q4 2026", kind: "maker", rows: ACTIVITY.rows.map((r) => ({ id: r.id, count: 0, ...(r.id === "published" ? { channels: [] } : {}) })) };
    render(<ProfilePage />);
    const c = within(await card());
    expect(await c.findByText("No plan file imported yet")).toBeTruthy();
    expect(c.getByText("Nothing sent for review yet")).toBeTruthy();
    expect(c.getByText("Nothing live yet")).toBeTruthy();
    expect(c.queryByText("From your plan files")).toBeNull();
  });

  it("the design team sees its reviews, not the Marketing rows", async () => {
    h.role = "designer";
    answers["/user/activity"] = { quarter: "Q4 2026", kind: "reviewer", rows: [{ id: "reviewed", count: 46 }, { id: "sentBack", count: 3 }, { id: "templates", count: 2 }] };
    render(<ProfilePage />);
    const c = within(await card());
    expect(await c.findByText("Designs approved")).toBeTruthy();
    expect(c.getByText("46")).toBeTruthy();
    expect(c.getByText("Sent back to Marketing")).toBeTruthy();
    expect(c.getByText("Templates added")).toBeTruthy();
    expect(c.queryByText("Posts imported")).toBeNull();
    expect(c.queryByText("Sent to Design Team")).toBeNull();
  });

  it("while it loads there is a skeleton, and the old made-up numbers are never drawn", async () => {
    h.apiFetch.mockImplementation(() => new Promise(() => {}));
    render(<ProfilePage />);
    expect(screen.getByLabelText("Loading your activity").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("From your Q4 plan file")).toBeNull();
  });

  it("when it cannot be loaded it says so and offers to try again", async () => {
    answers["/user/activity"] = new Error("Network down");
    render(<ProfilePage />);
    expect(await screen.findByText(/We couldn't load your activity/)).toBeTruthy();
    answers["/user/activity"] = ACTIVITY;
    const c = within(await card());
    await userEvent.click(c.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Posts imported")).toBeTruthy();
  });

  it("the card is there in production too: the numbers are real", async () => {
    vi.stubEnv("NODE_ENV", "production");
    render(<ProfilePage />);
    expect(await screen.findByText("Posts imported")).toBeTruthy();
    vi.unstubAllEnvs();
  });
});

describe("My Profile: the photo", () => {
  const picker = () => screen.getByLabelText("Choose a photo") as HTMLInputElement;
  // applyAccept off: a browser's file dialog can be switched to All files, so a wrong file still reaches the page
  const pick = (file: File) => userEvent.setup({ applyAccept: false }).upload(picker(), file);
  const png = (size = 1000, type = "image/png", name = "me.png") => new File([new Uint8Array(size)], name, { type });
  const withPhoto = () => {
    h.user = { ...h.user!, avatarUrl: "http://localhost:3001/uploads/avatars/me.webp" };
  };

  it("Change photo opens the file picker, which takes only JPG, PNG and WebP", async () => {
    render(<ProfilePage />);
    expect(picker().accept).toBe("image/jpeg,image/png,image/webp");
    const click = vi.spyOn(picker(), "click");
    await userEvent.click(screen.getByRole("button", { name: "Change photo" }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("a good picture is sent as the file field, every avatar is refreshed, and the person is told", async () => {
    render(<ProfilePage />);
    const file = png();
    await pick(file);
    await waitFor(() => expect(calls("/user/avatar")).toHaveLength(1));
    const [, init] = calls("/user/avatar")[0];
    expect(init.method).toBe("POST");
    expect((init.body as FormData).get("file")).toBe(file);
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.toast.success).toHaveBeenCalledWith("Photo updated");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a file that is not a picture is not sent, and the reason is on the page", async () => {
    render(<ProfilePage />);
    await pick(png(1000, "application/pdf", "cv.pdf"));
    expect((await screen.findByRole("alert")).textContent).toBe("That file isn't a JPG, PNG or WebP picture.");
    expect(calls("/user/avatar")).toHaveLength(0);
  });

  it("a file over 5 MB is not sent", async () => {
    render(<ProfilePage />);
    await pick(png(5_000_001));
    expect((await screen.findByRole("alert")).textContent).toBe("The picture is larger than 5 MB.");
    expect(calls("/user/avatar")).toHaveLength(0);
  });

  it("a picture under 400 x 400 is not sent, and the size is in the words", async () => {
    h.photoSize = { width: 300, height: 900 };
    render(<ProfilePage />);
    await pick(png());
    expect((await screen.findByRole("alert")).textContent).toBe("The picture is smaller than 400 × 400 px. Use a bigger one.");
    expect(calls("/user/avatar")).toHaveLength(0);
  });

  it("a file the browser cannot read as a picture is not sent", async () => {
    h.photoSize = null;
    render(<ProfilePage />);
    await pick(png());
    expect((await screen.findByRole("alert")).textContent).toBe("We couldn't read that picture. Try a different file.");
    expect(calls("/user/avatar")).toHaveLength(0);
  });

  it("when the API refuses, its words are on the page, nothing is refreshed, and the next try clears them", async () => {
    answers["/user/avatar"] = new Error("The picture is larger than 5 MB.");
    render(<ProfilePage />);
    await pick(png());
    expect((await screen.findByRole("alert")).textContent).toBe("The picture is larger than 5 MB.");
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.toast.success).not.toHaveBeenCalled();
    delete answers["/user/avatar"];
    await pick(png());
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("Remove is off while there is no photo", async () => {
    render(<ProfilePage />);
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Remove asks first; confirming deletes the photo, refreshes, and says so; cancelling does nothing", async () => {
    withPhoto();
    render(<ProfilePage />);
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Remove your photo?")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls("/user/avatar")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls("/user/avatar")).toHaveLength(1));
    expect(calls("/user/avatar")[0][1]).toEqual({ method: "DELETE" });
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.toast.success).toHaveBeenCalledWith("Photo removed");
  });

  it("when Remove fails the dialog stays so it can be tried again, and the failure is said", async () => {
    withPhoto();
    answers["/user/avatar"] = new Error("Something went wrong");
    render(<ProfilePage />);
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Something went wrong"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("the buttons wait while a photo is being saved", async () => {
    let finish: (v: unknown) => void = () => {};
    h.apiFetch.mockImplementation(async (path: string) => (path === "/user/avatar" ? new Promise((r) => (finish = r)) : base(path)));
    withPhoto();
    render(<ProfilePage />);
    await pick(png());
    const change = await screen.findByRole("button", { name: "Saving…" });
    expect((change as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(true);
    finish({ user: {} });
    await waitFor(() => expect(screen.getByRole("button", { name: "Change photo" })).toBeTruthy());
  });
});

describe("My Profile: two-step verification", () => {
  const ON = { enabled: true, enabledAt: "2026-11-18T03:00:00.000Z", recoveryLeft: 6, available: true };
  const row = () => screen.getByText("Two-step verification").closest("li")!;

  it("while it is off the row says what it does and offers Turn on; there is no 'On' pill", async () => {
    render(<ProfilePage />);
    await screen.findByText("Ask for a code from an authenticator app each time you sign in.");
    expect(within(row()).getByRole("button", { name: "Turn on" })).toBeTruthy();
    expect(within(row()).queryByText("On")).toBeNull();
  });

  it("when the API says it is on, the row says since when and how many recovery codes are left, with Manage", async () => {
    answers["/user/two-step"] = ON;
    render(<ProfilePage />);
    expect(await screen.findByText("On since 18 Nov 2026 · 6 recovery codes left")).toBeTruthy();
    expect(within(row()).getByText("On")).toBeTruthy();
    expect(within(row()).getByRole("button", { name: "Manage" })).toBeTruthy();
  });

  it("an account that signs in with Google or LinkedIn is told why, and has no button", async () => {
    answers["/user/two-step"] = { enabled: false, enabledAt: null, recoveryLeft: 0, available: false };
    render(<ProfilePage />);
    expect(await screen.findByText("Your account signs in with Google or LinkedIn, which has its own verification.")).toBeTruthy();
    expect(within(row()).queryByRole("button")).toBeNull();
  });

  it("nothing is claimed before the API has answered: no 'On', no made-up date", async () => {
    answers["/user/two-step"] = new Error("down");
    render(<ProfilePage />);
    await screen.findByText("Password recovery");
    expect(screen.queryByText("Two-step verification")).toBeNull();
    expect(screen.queryByText(/Authenticator app/)).toBeNull();
  });

  it("Turn on opens the dialog and asks the API for a fresh secret", async () => {
    answers["/user/two-step/start"] = { setupKey: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Postly:a%40b.co?secret=JBSWY3DPEHPK3PXP&issuer=Postly" };
    render(<ProfilePage />);
    await screen.findByText("Ask for a code from an authenticator app each time you sign in.");
    await userEvent.click(within(row()).getByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Turn on two-step verification")).toBeTruthy();
    await waitFor(() => expect(calls("/user/two-step/start")).toHaveLength(1));
    expect(within(dialog).getByText("JBSW Y3DP EHPK 3PXP")).toBeTruthy(); // the key to type, in groups
    expect(within(dialog).getByRole("img", { name: /QR code/ })).toBeTruthy();
  });

  it("the right first code turns it on, shows the recovery codes once, and the page reads the state and the devices again", async () => {
    answers["/user/two-step/start"] = { setupKey: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Postly:a%40b.co?secret=JBSWY3DPEHPK3PXP&issuer=Postly" };
    answers["/user/two-step/enable"] = { ok: true, recoveryCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"] };
    render(<ProfilePage />);
    await screen.findByText("Ask for a code from an authenticator app each time you sign in.");
    await userEvent.click(within(row()).getByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("JBSW Y3DP EHPK 3PXP");
    const before = { state: calls("/user/two-step").length, devices: calls("/user/devices").length };
    await userEvent.type(within(dialog).getByLabelText("Your password"), "Password123");
    await userEvent.type(within(dialog).getByLabelText("Digit 1 of 6"), "123456");
    await waitFor(() => expect(calls("/user/two-step/enable")).toHaveLength(1));
    expect(calls("/user/two-step/enable")[0][1]).toEqual({ method: "POST", body: JSON.stringify({ password: "Password123", code: "123456" }) });
    expect(await within(dialog).findByText("Save your recovery codes")).toBeTruthy();
    expect(within(dialog).getByText("AAAAA-BBBBB")).toBeTruthy();
    await waitFor(() => expect(calls("/user/two-step").length).toBe(before.state + 1)); // the row will say On
    expect(calls("/user/devices").length).toBe(before.devices + 1); // the other devices were signed out
  });

  // The page reads the state again as soon as it is on, so `enabled` turns true while the codes are on screen. The dialog must
  // keep showing them: swapping them for "Manage" would lose the only copy the person will ever see.
  it("the recovery codes stay on screen when the page learns that it is on", async () => {
    answers["/user/two-step/start"] = { setupKey: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" };
    answers["/user/two-step/enable"] = { ok: true, recoveryCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"] };
    render(<ProfilePage />);
    await screen.findByText("Ask for a code from an authenticator app each time you sign in.");
    await userEvent.click(within(row()).getByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("JBSW Y3DP EHPK 3PXP");
    // from now on the API says it is on, which is what the page reads after enabling
    answers["/user/two-step"] = { enabled: true, enabledAt: "2026-11-18T03:00:00.000Z", recoveryLeft: 2, available: true };
    await userEvent.type(within(dialog).getByLabelText("Your password"), "Password123");
    await userEvent.type(within(dialog).getByLabelText("Digit 1 of 6"), "123456");
    await within(dialog).findByText("Save your recovery codes");
    await screen.findByText("On since 18 Nov 2026 · 2 recovery codes left"); // the page has learned it is on...
    expect(within(dialog).getByText("AAAAA-BBBBB")).toBeTruthy(); // ...and the codes are still there
    expect(within(dialog).queryByText("Two-step verification")).toBeNull(); // not replaced by Manage
    expect(within(dialog).queryByRole("button", { name: "Turn off" })).toBeNull();
  });

  it("the recovery codes cannot be closed away before they are saved: Done waits for the tick, and so does the close button", async () => {
    answers["/user/two-step/start"] = { setupKey: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" };
    answers["/user/two-step/enable"] = { ok: true, recoveryCodes: ["AAAAA-BBBBB"] };
    render(<ProfilePage />);
    await screen.findByText("Ask for a code from an authenticator app each time you sign in.");
    await userEvent.click(within(row()).getByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("JBSW Y3DP EHPK 3PXP");
    await userEvent.type(within(dialog).getByLabelText("Your password"), "Password123");
    await userEvent.type(within(dialog).getByLabelText("Digit 1 of 6"), "123456");
    await within(dialog).findByText("Save your recovery codes");
    expect((within(dialog).getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/Save your recovery codes first/);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "I saved these codes" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("the six digits typed before the password are not sent: the dialog says to type the password first", async () => {
    answers["/user/two-step/start"] = { setupKey: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" };
    render(<ProfilePage />);
    await screen.findByText("Ask for a code from an authenticator app each time you sign in.");
    await userEvent.click(within(row()).getByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("JBSW Y3DP EHPK 3PXP");
    await userEvent.type(within(dialog).getByLabelText("Digit 1 of 6"), "123456");
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Type your password first.");
    expect(calls("/user/two-step/enable")).toHaveLength(0);
  });

  it("a wrong first code is said in words, clears the boxes, and the dialog stays so it can be tried again", async () => {
    answers["/user/two-step/start"] = { setupKey: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" };
    answers["/user/two-step/enable"] = new Error("That code isn't right. Check your app and try again.");
    render(<ProfilePage />);
    await screen.findByText("Ask for a code from an authenticator app each time you sign in.");
    await userEvent.click(within(row()).getByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("JBSW Y3DP EHPK 3PXP");
    await userEvent.type(within(dialog).getByLabelText("Your password"), "Password123");
    await userEvent.type(within(dialog).getByLabelText("Digit 1 of 6"), "000000");
    expect((await within(dialog).findByRole("alert")).textContent).toBe("That code isn't right. Check your app and try again.");
    expect((within(dialog).getByLabelText("Digit 1 of 6") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("Manage turns it off only with the password AND a code, and the button waits until both are typed", async () => {
    answers["/user/two-step"] = ON;
    answers["/user/two-step/disable"] = { ok: true };
    render(<ProfilePage />);
    await screen.findByText("On since 18 Nov 2026 · 6 recovery codes left");
    await userEvent.click(within(row()).getByRole("button", { name: "Manage" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("6 recovery codes left.")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
    const confirm = within(dialog).getByRole("button", { name: "Turn off" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText("Your password"), "Password123");
    expect(confirm.disabled).toBe(true); // a password alone is not enough
    await userEvent.type(within(dialog).getByLabelText("Code from your app, or a recovery code"), "123456");
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() => expect(calls("/user/two-step/disable")).toHaveLength(1));
    expect(calls("/user/two-step/disable")[0][1]).toEqual({ method: "POST", body: JSON.stringify({ password: "Password123", code: "123456" }) });
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Two-step verification is off"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a refused Turn off keeps the dialog open with the reason, and a recovery code is accepted as the code", async () => {
    answers["/user/two-step"] = ON;
    answers["/user/two-step/disable"] = new Error("Your password isn't right.");
    render(<ProfilePage />);
    await screen.findByText("On since 18 Nov 2026 · 6 recovery codes left");
    await userEvent.click(within(row()).getByRole("button", { name: "Manage" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
    await userEvent.type(within(dialog).getByLabelText("Your password"), "wrong");
    await userEvent.type(within(dialog).getByLabelText("Code from your app, or a recovery code"), "ABCDE-FGHJK");
    await userEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Your password isn't right.");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(calls("/user/two-step/disable")[0][1]).toEqual({ method: "POST", body: JSON.stringify({ password: "wrong", code: "ABCDE-FGHJK" }) });
  });

  it("new recovery codes need the password and a code too, and then show the new codes once", async () => {
    answers["/user/two-step"] = ON;
    answers["/user/two-step/recovery-codes"] = { ok: true, recoveryCodes: ["NEWAA-BBBBB"] };
    render(<ProfilePage />);
    await screen.findByText("On since 18 Nov 2026 · 6 recovery codes left");
    await userEvent.click(within(row()).getByRole("button", { name: "Manage" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "New recovery codes" }));
    expect(within(dialog).getByText("The codes you have now stop working.")).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText("Your password"), "Password123");
    await userEvent.type(within(dialog).getByLabelText("Code from your app, or a recovery code"), "123456");
    await userEvent.click(within(dialog).getByRole("button", { name: "Make new codes" }));
    expect(await within(dialog).findByText("NEWAA-BBBBB")).toBeTruthy();
    expect(calls("/user/two-step/recovery-codes")[0][1]).toEqual({ method: "POST", body: JSON.stringify({ password: "Password123", code: "123456" }) });
  });

  it("what was typed is gone when the dialog is opened again", async () => {
    answers["/user/two-step"] = ON;
    render(<ProfilePage />);
    await screen.findByText("On since 18 Nov 2026 · 6 recovery codes left");
    await userEvent.click(within(row()).getByRole("button", { name: "Manage" }));
    let dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
    await userEvent.type(within(dialog).getByLabelText("Your password"), "secret-typed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect((await within(dialog).findAllByRole("button", { name: "Turn off" })).length).toBeGreaterThan(0);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(within(row()).getByRole("button", { name: "Manage" }));
    dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
    expect((within(dialog).getByLabelText("Your password") as HTMLInputElement).value).toBe("");
  });
});
