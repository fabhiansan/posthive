"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";
import type { ApiDashboard } from "./dashboard-data";

// The server picks the workspace (the user's active one), and switching workspace reloads the whole
// app, so the hook is not keyed on the workspace: one request when the page opens, not one more when
// the workspace list arrives.

export interface DashboardState<T = ApiDashboard> {
  data: T | null;
  loading: boolean;
  /** Why the numbers could not be loaded. The page keeps what it had, if it had anything. */
  error: string | null;
  reload: () => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");

/** The workspace's numbers: the marketing dashboard's by default, or another role's page (`/dashboard/design`). */
export function useDashboard<T = ApiDashboard>(path = "/dashboard"): DashboardState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const request = useRef(0);

  useEffect(() => {
    const id = ++request.current;
    setLoading(true);
    apiFetch<T>(path)
      .then((answer) => {
        if (request.current !== id) return;
        setData(answer);
        setError(null);
      })
      .catch((e) => {
        if (request.current === id) setError(message(e));
      })
      .finally(() => {
        if (request.current === id) setLoading(false);
      });
    return () => {
      request.current += 1;
    };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}
