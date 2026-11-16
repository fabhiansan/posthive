"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState } from "react";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/cn";
import { useWorkspaceWait } from "./useWorkspaceWait";

/** The loading stages a Canvas page can report. "Session and workspace" is read from the app itself. */
export type BootStage = "engine" | "document" | "assets";

export type StageStatus =
  | { state: "pending" | "active" | "done" | "na" }
  | { state: "error"; message: string; retry: () => void };

type Report = (stage: BootStage, status: StageStatus) => void;

const BootContext = createContext<Report>(() => {});

/** Pages call this to say how far each stage is. Every Canvas page reports all three. */
export function useBootReport(): Report {
  return useContext(BootContext);
}

/** For pages that open no editor (like the review queue): nothing to wait for. */
export function useBootNone(): void {
  const report = useBootReport();
  useLayoutEffect(() => {
    report("engine", { state: "na" });
    report("document", { state: "na" });
    report("assets", { state: "na" });
  }, [report]);
}

type Row = { id: string; label: string; detail?: string; status: StageStatus };

const LEAVE_MS = 200;

/**
 * Full-screen loader for the first open of any /canvas page. It sits around the existing guards
 * (AuthGuard, PlanGuard, RoleGuard), which keep doing their own work underneath. It shows real
 * readiness only: the session, the workspace, and whatever the page reports. Once everything is
 * ready it fades out and stays gone while the person moves between Canvas pages.
 */
export function CanvasBoot({ children }: { children: React.ReactNode }) {
  const wait = useWorkspaceWait();

  const [stages, setStages] = useState<Record<BootStage, StageStatus>>({
    engine: { state: "pending" },
    document: { state: "pending" },
    assets: { state: "pending" },
  });
  const report = useCallback<Report>((stage, status) => setStages((prev) => ({ ...prev, [stage]: status })), []);

  const sessionRow = { id: "session", label: "Session and workspace" };
  let session: Row;
  switch (wait.status) {
    case "checking-session":
      session = { ...sessionRow, detail: "Checking your session", status: { state: "active" } };
      break;
    case "signed-out":
      session = { ...sessionRow, detail: "Taking you to sign in", status: { state: "active" } };
      break;
    case "loading":
      session = { ...sessionRow, detail: "Loading your workspace", status: { state: "active" } };
      break;
    case "timeout":
      session = {
        ...sessionRow,
        status: { state: "error", message: "Your workspace didn't load. Check your connection and try again.", retry: wait.retry },
      };
      break;
    case "ready":
      session = { ...sessionRow, detail: wait.workspaceName, status: { state: "done" } };
      break;
  }

  const rows: Row[] = [
    session,
    { id: "engine", label: "Editor engine", status: stages.engine },
    { id: "document", label: "Design document", detail: stages.document.state === "done" ? "New blank design" : undefined, status: stages.document },
    { id: "assets", label: "Assets and fonts", status: stages.assets },
  ];
  const ready = rows.every((r) => r.status.state === "done" || r.status.state === "na");

  const [phase, setPhase] = useState<"loading" | "leaving" | "gone">("loading");
  useEffect(() => {
    if (phase === "loading" && ready) setPhase("leaving");
    if (phase !== "leaving") return;
    const t = setTimeout(() => setPhase("gone"), LEAVE_MS);
    return () => clearTimeout(t);
  }, [phase, ready]);

  return (
    <>
      {/* The editor is mounted underneath so it can load, but nothing in it is reachable until the loader is gone. */}
      <div className="contents" inert={phase === "loading"}>
        <BootContext.Provider value={report}>{children}</BootContext.Provider>
      </div>
      {phase !== "gone" && <BootScreen rows={rows} leaving={phase === "leaving"} workspaceName={wait.workspaceName} />}
    </>
  );
}

function StatusIcon({ state }: { state: StageStatus["state"] }) {
  if (state === "done") {
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-green-100 text-green-700">
        <CheckIcon className="size-3" strokeWidth={3} />
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-red-50 text-red-600">
        <CircleAlertIcon className="size-3.5" />
      </span>
    );
  }
  if (state === "active") return <Spinner size="sm" label="In progress" className="mx-[3px] text-brand-800" />;
  return <span className="mx-[3px] size-3.5 rounded-full border-2 border-neutral-100" />;
}

function BootScreen({ rows, leaving, workspaceName }: { rows: Row[]; leaving: boolean; workspaceName?: string }) {
  return (
    <div
      className={cn(
        "theme-dashboard fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-background transition-opacity duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
        leaving && "pointer-events-none opacity-0",
      )}
    >
      {/* A quiet outline of the editor behind the card, so the layout is already familiar when it appears. */}
      <div aria-hidden className="absolute inset-0 flex flex-col">
        <div className="flex h-14 items-center gap-3 border-b border-border bg-surface px-4">
          <Skeleton className="size-8 motion-reduce:animate-none" />
          <Skeleton className="h-4 w-32 motion-reduce:animate-none" />
          <Skeleton className="ml-auto h-8 w-24 motion-reduce:animate-none" />
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="hidden w-60 shrink-0 flex-col gap-3 border-r border-border bg-surface p-4 lg:flex">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 motion-reduce:animate-none" />
            ))}
          </div>
          <div className="flex flex-1 items-center justify-center p-12">
            <Skeleton className="aspect-square h-full max-h-[34rem] bg-surface motion-reduce:animate-none" />
          </div>
          <div className="hidden w-80 shrink-0 flex-col gap-3 border-l border-border bg-surface p-4 lg:flex">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 motion-reduce:animate-none" />
            ))}
          </div>
        </div>
      </div>

      <div
        role="status"
        aria-live="polite"
        className="card relative mx-4 w-full max-w-sm bg-surface p-6 shadow-xl"
      >
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/posthivemain.png" alt="" className="size-10 rounded-xl" />
          <div className="min-w-0">
            <p className="type-head-sb-6 text-fg">Opening Canvas</p>
            <p className="truncate type-body-r-xs text-muted">{workspaceName ? `Getting ${workspaceName} ready` : "Getting your workspace ready"}</p>
          </div>
        </div>

        <ul className="mt-5 flex flex-col gap-3">
          {rows
            .filter((r) => r.status.state !== "na")
            .map((r) => (
              <li key={r.id} className="flex items-start gap-3">
                <div className="mt-0.5 flex w-5 shrink-0 justify-center">
                  <StatusIcon state={r.status.state} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={cn("type-body-m-s", r.status.state === "pending" ? "text-muted" : "text-fg")}>{r.label}</p>
                  {r.status.state === "error" ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <p className="type-body-r-xs text-red-600">{r.status.message}</p>
                      <Button variant="secondary" size="sm" onClick={r.status.retry}>
                        Try again
                      </Button>
                    </div>
                  ) : (
                    r.detail && <p className="truncate type-body-r-xs text-muted">{r.detail}</p>
                  )}
                </div>
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}
