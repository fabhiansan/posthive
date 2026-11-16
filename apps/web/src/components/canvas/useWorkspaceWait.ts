"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useWorkspace } from "@/context/WorkspaceContext";

/** How long a signed-in person waits for their workspace before Canvas offers a retry. */
export const WORKSPACE_TIMEOUT_MS = 8_000;

export type WorkspaceStatus = "checking-session" | "signed-out" | "loading" | "timeout" | "ready";

/**
 * Where Canvas is with "who is this and which workspace". WorkspaceContext marks itself loaded
 * before sign-in has finished, so its `loading` flag cannot be trusted here. The workspace being
 * present is the signal instead. If it has not arrived after 8 seconds the status becomes
 * "timeout", and retry() asks the workspace provider to load again and restarts the wait.
 */
export function useWorkspaceWait(): { status: WorkspaceStatus; workspaceName?: string; retry: () => void } {
  const { user, loading: authLoading } = useAuth();
  const { activeWorkspace, refresh } = useWorkspace();
  const [attempt, setAttempt] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const waiting = !!user && !activeWorkspace;

  useEffect(() => {
    setTimedOut(false);
    if (!waiting) return;
    const timer = setTimeout(() => setTimedOut(true), WORKSPACE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [waiting, attempt]);

  function retry() {
    setTimedOut(false);
    setAttempt((n) => n + 1);
    refresh();
  }

  let status: WorkspaceStatus;
  if (authLoading) status = "checking-session";
  else if (!user) status = "signed-out";
  else if (activeWorkspace) status = "ready";
  else status = timedOut ? "timeout" : "loading";

  return { status, workspaceName: activeWorkspace?.name, retry };
}
