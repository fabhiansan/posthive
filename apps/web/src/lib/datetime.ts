// All schedule times in the UI are shown and entered in WIB (Asia/Jakarta, GMT+7),
// 24-hour clock, regardless of the browser's timezone. Jakarta has no DST, so the
// fixed +07:00 offset is always correct. Storage stays ISO UTC.

export const APP_TIMEZONE = "Asia/Jakarta";
export const APP_TZ_LABEL = "WIB";
const OFFSET = "+07:00";
const OFFSET_MS = 7 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, "0");

export function formatTime(d: Date, opts: { seconds?: boolean } = {}): string {
  return d.toLocaleTimeString("en-US", {
    timeZone: APP_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    ...(opts.seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  });
}

export function formatDate(d: Date, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  return d.toLocaleDateString("en-US", { ...opts, timeZone: APP_TIMEZONE });
}

// "Oct 23, 2026 · 14:30"
export function formatDateTime(d: Date, dateOpts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }): string {
  return `${formatDate(d, dateOpts)} · ${formatTime(d)}`;
}

// Date → "YYYY-MM-DDTHH:mm" as WIB wall-clock
export function toWibInput(d: Date): string {
  const w = new Date(d.getTime() + OFFSET_MS);
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`;
}

// "YYYY-MM-DDTHH:mm" (WIB wall-clock) → absolute Date
export function fromWibInput(s: string): Date {
  const [date, time] = s.split("T");
  return new Date(`${date}T${(time ?? "09:00").slice(0, 5)}:00${OFFSET}`);
}

// Calendar date in WIB, "YYYY-MM-DD"
export function wibDateKey(d: Date): string {
  return toWibInput(d).slice(0, 10);
}

// Earliest selectable repeat end date, WIB-based
export function minKeyForInterval(interval: "daily" | "weekly" | "monthly"): string {
  return addDaysKey(wibDateKey(new Date()), interval === "daily" ? 1 : interval === "weekly" ? 7 : 0, interval === "monthly" ? 1 : 0);
}

// Calendar arithmetic on a "YYYY-MM-DD" key (timezone-free)
export function addDaysKey(key: string, days: number, months = 0): string {
  const t = new Date(`${key}T00:00:00Z`);
  if (months) t.setUTCMonth(t.getUTCMonth() + months);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

// CSV dates like "2026-07-10 09:00" are WIB unless they carry an explicit Z/offset.
export function parseCsvDate(raw: string): Date {
  const s = raw.trim().replace(" ", "T");
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return new Date(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fromWibInput(`${s}T00:00`);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return fromWibInput(s);
  return new Date(NaN);
}
