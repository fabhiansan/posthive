"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./api";

/** The posts of a template's category (the design team's dialogs name them before an Unpublish or a Delete). */
export type TemplateUsage = { created: number; inReview: number };

/**
 * Asks the API for the counts when `open` turns true, and forgets them when it turns false, so a dialog never shows the numbers
 * of the last time. Until the answer is here, and when the request fails, it is null: a dialog says nothing it does not know.
 */
export function useTemplateUsage(id: string | undefined, open: boolean): TemplateUsage | null {
  const [usage, setUsage] = useState<TemplateUsage | null>(null);
  useEffect(() => {
    if (!open || !id) {
      setUsage(null);
      return;
    }
    let live = true;
    apiFetch<TemplateUsage>(`/templates/${id}/usage`).then(
      (u) => live && setUsage({ created: Number(u.created) || 0, inReview: Number(u.inReview) || 0 }),
      () => live && setUsage(null),
    );
    return () => {
      live = false;
    };
  }, [id, open]);
  return usage;
}
