"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTask, fetchTasks, type TaskDetail, type TaskList, type TaskTab } from "./design-tasks";

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");

export interface AsyncState<T> {
  /** The last answer. While the next one loads it is still the old one, so the page does not flash empty. */
  data: T | null;
  loading: boolean;
  error: string | null;
  /** The server's HTTP status when it answered (404: not your task); undefined for a network error. */
  status: number | undefined;
  reload: () => void;
}

/** One request, re-asked when `key` changes or `reload()` is called. An answer for a request the person already left is dropped. */
function useAsync<T>(key: string, ask: () => Promise<T>): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const request = useRef(0);
  const askRef = useRef(ask);
  askRef.current = ask;

  useEffect(() => {
    const id = ++request.current;
    setLoading(true);
    askRef
      .current()
      .then((answer) => {
        if (request.current !== id) return;
        setData(answer);
        setError(null);
        setStatus(undefined);
      })
      .catch((e) => {
        if (request.current !== id) return;
        setError(message(e));
        setStatus((e as { status?: number }).status);
      })
      .finally(() => {
        if (request.current === id) setLoading(false);
      });
    return () => {
      request.current += 1;
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, status, reload };
}

/** One page of one tab of My Task. */
export const useTaskList = (tab: TaskTab, page: number): AsyncState<TaskList> => useAsync(`${tab}:${page}`, () => fetchTasks(tab, page));

/** One task. */
export const useTask = (postId: string): AsyncState<TaskDetail> => useAsync(postId, () => fetchTask(postId));
