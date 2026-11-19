"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";
import type { ApiActivity, ApiDevices } from "./profile-security";
import type { ApiTwoStep } from "./two-step";

export interface Loaded<T> {
  data: T | null;
  loading: boolean;
  /** Why it could not be loaded. The card keeps what it had, if it had anything. */
  error: string | null;
  reload: () => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");

/** One answer from the API for a card of the profile page; the newest request wins, so a slow old one never overwrites it. */
function useLoaded<T>(path: string): Loaded<T> {
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

/** The devices the account is open on and its recent sign-ins. */
export const useDevices = () => useLoaded<ApiDevices>("/user/devices");

/** Whether two-step verification is on, since when, and how many recovery codes are left. */
export const useTwoStep = () => useLoaded<ApiTwoStep>("/user/two-step");

/** What the person did this quarter. */
export const useActivity = () => useLoaded<ApiActivity>("/user/activity");
