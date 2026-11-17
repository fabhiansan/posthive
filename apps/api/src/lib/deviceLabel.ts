// What the profile page calls a device. Only the labels leave the server, never the raw User-Agent: it is text the
// other side chose, and it can be long.

export interface DeviceLabel {
  /** The short word in the square tile of the list. */
  tile: string;
  /** "Chrome on macOS" */
  name: string;
}

/** The header is cut here before it is stored. */
export const USER_AGENT_MAX = 300;

/** The User-Agent as it is stored: trimmed, cut, and null when there is nothing in it. */
export function cleanUserAgent(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const ua = raw.trim().slice(0, USER_AGENT_MAX);
  return ua === "" ? null : ua;
}

// The order matters: an iPhone says "like Mac OS X", Edge and Opera also say "Chrome", Chrome also says "Safari".
const SYSTEMS: [RegExp, string, string][] = [
  [/iPhone|iPad|iPod/i, "iOS", "iOS"],
  [/Android/i, "Android", "Droid"],
  [/Windows/i, "Windows", "Win"],
  [/CrOS/i, "ChromeOS", "CrOS"],
  [/Macintosh|Mac OS X/i, "macOS", "Mac"],
  [/Linux|X11/i, "Linux", "Linux"],
];

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//i, "Edge"],
  [/OPR\/|Opera/i, "Opera"],
  [/Firefox\/|FxiOS\//i, "Firefox"],
  [/Chrome\/|CriOS\//i, "Chrome"],
  [/Safari\//i, "Safari"],
];

export function deviceOf(userAgent: string | null | undefined): DeviceLabel {
  const ua = userAgent ?? "";
  const system = SYSTEMS.find(([re]) => re.test(ua));
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? "Browser";
  return { tile: system?.[2] ?? "Web", name: system ? `${browser} on ${system[1]}` : browser };
}
