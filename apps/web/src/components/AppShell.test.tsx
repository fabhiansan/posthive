// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pathname: "/canvas",
  user: { id: "u1", role: "designer" } as Record<string, unknown> | null,
  authLoading: false,
  workspace: { id: "w1", name: "Postly Studio", role: "designer" } as Record<string, unknown> | null,
  refresh: vi.fn(),
  canAccess: true,
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
  useRouter: () => ({ replace: h.replace, push: vi.fn() }),
}));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: h.user, loading: h.authLoading }) }));
vi.mock("@/context/WorkspaceContext", () => ({
  useWorkspace: () => ({ activeWorkspace: h.workspace, refresh: h.refresh }),
}));
vi.mock("@/lib/usePermissions", () => ({ usePermissions: () => ({ canAccess: () => h.canAccess, loading: false }) }));

// The guards and the sidebar get marker elements, so the tests can see which ones wrap the page.
vi.mock("./AuthGuard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <div data-testid="auth-guard">{children}</div>,
}));
vi.mock("./PlanGuard", () => ({
  PlanGuard: ({ children }: { children: React.ReactNode }) => <div data-testid="plan-guard">{children}</div>,
}));
vi.mock("./app-sidebar/AppSidebar", () => ({
  AppSidebar: () => <nav data-testid="sidebar" />,
  MobileMenuButton: () => null,
}));
vi.mock("./OnboardingChecklist", () => ({ OnboardingChecklist: () => null }));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

import { AppShell } from "./AppShell";
import { CanvasBoot, useBootReport } from "./canvas/CanvasBoot";

beforeEach(() => {
  h.pathname = "/canvas";
  h.user = { id: "u1", role: "designer" };
  h.authLoading = false;
  h.workspace = { id: "w1", name: "Postly Studio", role: "designer" };
  h.canAccess = true;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("AppShell", () => {
  it.each(["/canvas", "/canvas/reviews", "/canvas/clx1y2z3a0000abcd"])("%s sits inside the auth and plan guards, with no sidebar", (path) => {
    h.pathname = path;
    render(
      <AppShell>
        <p>editor</p>
      </AppShell>,
    );

    const plan = within(within(screen.getByTestId("auth-guard")).getByTestId("plan-guard"));
    expect(plan.getByText("editor")).toBeTruthy();
    expect(screen.queryByTestId("sidebar")).toBeNull();
  });

  it("keeps the role guard on Canvas: a role that may not open the page sees nothing and goes to /jobs", () => {
    h.canAccess = false;
    render(
      <AppShell>
        <p>editor</p>
      </AppShell>,
    );

    expect(screen.queryByText("editor")).toBeNull();
    expect(h.replace).toHaveBeenCalledWith("/jobs");
  });

  // /canvas/<id> is a Canvas page (one segment). Anything deeper is not, so it must not get the Canvas loader.
  it.each(["/jobs", "/canvas/abc/def", "/canvas/abc/def/ghi"])("%s keeps the normal app layout", (path) => {
    h.pathname = path;
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );

    const plan = within(within(screen.getByTestId("auth-guard")).getByTestId("plan-guard"));
    expect(plan.getByTestId("sidebar")).toBeTruthy();
    expect(plan.getByText("page")).toBeTruthy();
    expect(screen.queryByText("Opening Canvas")).toBeNull();
  });
});

function Reporter({ assets }: { assets: "done" | "active" }) {
  const report = useBootReport();
  useLayoutEffect(() => {
    report("engine", { state: "done" });
    report("document", { state: "done" });
    report("assets", { state: assets });
  }, [report, assets]);
  return <p>editor</p>;
}

describe("CanvasBoot", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays up while a stage is still loading, then leaves once every stage is done", () => {
    const { container, rerender } = render(
      <CanvasBoot>
        <Reporter assets="active" />
      </CanvasBoot>,
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("Opening Canvas")).toBeTruthy();
    expect(container.querySelector("[inert]")).not.toBeNull();

    rerender(
      <CanvasBoot>
        <Reporter assets="done" />
      </CanvasBoot>,
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("Opening Canvas")).toBeNull();
    expect(container.querySelector("[inert]")).toBeNull();
  });

  it("says it is loading the workspace while a signed-in person has none yet", () => {
    h.workspace = null;
    render(
      <CanvasBoot>
        <Reporter assets="done" />
      </CanvasBoot>,
    );

    expect(screen.getByText("Loading your workspace")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("after 8 seconds offers Try again, which reloads the workspace and starts waiting again", () => {
    h.workspace = null;
    render(
      <CanvasBoot>
        <Reporter assets="done" />
      </CanvasBoot>,
    );

    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(screen.queryByText(/didn't load/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText(/Your workspace didn't load/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading your workspace")).toBeTruthy();
    expect(screen.queryByText(/didn't load/)).toBeNull();
  });
});
