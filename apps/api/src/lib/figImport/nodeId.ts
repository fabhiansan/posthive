export function nodeId(node: unknown): string | null {
  if (typeof node !== "object" || node === null) return null;
  const guid = (node as { guid?: unknown }).guid;
  if (typeof guid !== "object" || guid === null) return null;
  const { sessionID, localID } = guid as { sessionID?: unknown; localID?: unknown };
  return typeof sessionID === "number" && typeof localID === "number" && Number.isSafeInteger(sessionID) && Number.isSafeInteger(localID)
    ? `${sessionID}:${localID}`
    : null;
}
