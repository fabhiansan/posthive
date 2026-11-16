import { wibDateKey } from "./datetime";
import { formatPlanDate } from "./import-rows";

// The small facts of My Profile that are worked out, not stored: how a plan reads, which quarter the
// counts are for, since when the person is in the workspace.

const PLAN_NAME: Record<string, string> = { creator: "Creator", pro: "Pro", team: "Team" };

/** "Pro plan · annual". A trial and a cancelled plan have no interval to show, and neither has a plan whose interval is not known. */
export function planLine(plan: string | null | undefined, interval?: string): string {
  if (plan === "trialing") return "Free trial";
  if (plan === "cancelled") return "Plan cancelled";
  const name = plan && Object.hasOwn(PLAN_NAME, plan) ? PLAN_NAME[plan] : undefined;
  if (!name) return "No plan";
  return interval ? `${name} plan · ${interval}` : `${name} plan`;
}

const QUARTER_RESETS = ["1 January", "1 April", "1 July", "1 October"] as const;

/** The quarter of a day (in WIB, like every date of the app) and the day its counts start over: "Q4 2026", "1 January". */
export function quarterOf(day: Date): { label: string; resets: string } {
  const [year, month] = wibDateKey(day).split("-").map(Number);
  const quarter = Math.floor((month - 1) / 3);
  return { label: `Q${quarter + 1} ${year}`, resets: QUARTER_RESETS[(quarter + 1) % 4] };
}

/** "13 Nov 2026" from the day the person joined the workspace; empty when the date is missing or wrong. */
export function memberSince(iso: string | null | undefined): string {
  if (!iso) return "";
  const day = new Date(iso);
  return Number.isNaN(day.getTime()) ? "" : formatPlanDate(wibDateKey(day));
}

/** A social account of the workspace, as My Profile lists it. */
export interface ConnectedAccount {
  id: string;
  platform: string;
  displayName: string;
}
