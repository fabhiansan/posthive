import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

const TONE = {
  /** "Role: Marketing" */
  quiet: { pill: "bg-neutral-50 text-neutral-600", dot: "bg-neutral-600" },
  /** "Approves & publishes" */
  solid: { pill: "bg-green-700 text-white", dot: "bg-white" },
  /** "Pro plan · annual", "Marketing" */
  warm: { pill: "bg-brand-100 text-brand-800", dot: "bg-brand-800" },
} as const;

/** A small rounded label with a dot in front of it: the role, the duty and the plan at the top of My Profile. */
export function Pill({ tone, children, className }: { tone: keyof typeof TONE; children: ReactNode; className?: string }) {
  const { pill, dot } = TONE[tone];
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 type-body-sb-xxs whitespace-nowrap", pill, className)}>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {children}
    </span>
  );
}
