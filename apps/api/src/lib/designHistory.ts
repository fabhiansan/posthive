import { safeLink } from "./contentList.js";

export interface DesignEvent {
  kind: "submitted" | "revision" | "review_submitted" | "approved" | "returned";
  at: string;
  by: string | null;
  figmaUrl: string | null;
  note: string | null;
}

/** Only delivered versions and explicit revision instructions belong in shared history, never draft saves. */
export function designHistory(value: unknown): DesignEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e): DesignEvent[] => {
    if (!e || typeof e !== "object" || !["submitted", "revision", "review_submitted", "approved", "returned"].includes(e.kind) || typeof e.at !== "string" || !Number.isFinite(Date.parse(e.at))) return [];
    return [{ kind: e.kind, at: e.at, by: typeof e.by === "string" ? e.by : null, figmaUrl: safeLink(e.figmaUrl), note: typeof e.note === "string" ? e.note : null }];
  });
}
