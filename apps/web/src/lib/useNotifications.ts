"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from "./notifications";

/** How often the bell asks how many are unread. One count on an index, so a minute is cheap. */
export const POLL_MS = 60_000;

export interface NotificationsState {
  unread: number;
  /** null until the drawer was opened once. */
  items: NotificationItem[] | null;
  loading: boolean;
  error: string | null;
  /** Load the list (the drawer opened). */
  load: () => void;
  markRead: (n: NotificationItem) => void;
  markAllRead: () => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");

/**
 * The bell's badge and the drawer's list. The badge is asked when the page opens, every minute and when the window comes
 * back into view; the list only when the drawer opens. A failed poll keeps the last number: a bell that blinks to zero on a
 * bad connection would say "nothing new" when it does not know.
 */
export function useNotifications(enabled = true): NotificationsState {
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const refreshCount = useCallback(() => {
    fetchUnreadCount().then(setUnread).catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refreshCount();
    const timer = setInterval(refreshCount, POLL_MS);
    const onFocus = () => document.visibilityState === "visible" && refreshCount();
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", refreshCount);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", refreshCount);
    };
  }, [enabled, refreshCount]);

  const load = useCallback(() => {
    const id = ++request.current;
    setLoading(true);
    fetchNotifications()
      .then((answer) => {
        if (request.current !== id) return;
        setItems(answer.items);
        setUnread(answer.unread);
        setError(null);
      })
      .catch((e) => request.current === id && setError(message(e)))
      .finally(() => request.current === id && setLoading(false));
  }, []);

  // Optimistic: the row reads as read at once; the server is told, and the count is asked again if that failed. The caller
  // passes the row it clicked, so whether it was unread is known here and not worked out inside a state update.
  const markRead = useCallback(
    (n: NotificationItem) => {
      if (n.read) return;
      setItems((list) => list && list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
      markNotificationRead(n.id).catch(refreshCount);
    },
    [refreshCount],
  );

  const markAllRead = useCallback(() => {
    setItems((list) => list && list.map((n) => ({ ...n, read: true })));
    setUnread(0);
    markAllNotificationsRead().catch(refreshCount);
  }, [refreshCount]);

  return { unread, items, loading, error, load, markRead, markAllRead };
}
