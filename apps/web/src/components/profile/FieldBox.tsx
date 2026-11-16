import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** The box of a field of My Profile: an olive line, the page colour inside, the label small above the value. */
const FIELD_BOX = "rounded-xl border border-neutral-500 bg-bg px-3 py-2";

/** The text control inside a FieldBox: no box of its own, the FieldBox draws it. */
export const FIELD_CONTROL = "block w-full min-w-0 bg-transparent type-body-r-s text-fg outline-none placeholder:text-neutral-500";

const FIELD_LABEL = "block type-body-r-xxs text-neutral-600";

/**
 * A field whose label sits inside the box, above the value (the design's "Full name *"). The box is
 * the label of the control inside it, so a click anywhere in the box focuses it, and it lights up
 * while the control has focus.
 */
export function FieldBox({ label, invalid, className, children }: { label: ReactNode; invalid?: boolean; className?: string; children: ReactNode }) {
  return (
    <label
      className={cn(FIELD_BOX, "block cursor-text focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/30", invalid && "border-red-400", className)}
    >
      <span className={FIELD_LABEL}>{label}</span>
      {children}
    </label>
  );
}

/** The same box for a value the person cannot change ("Role · set by admin"). */
export function ReadOnlyBox({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn(FIELD_BOX, className)}>
      <span className={FIELD_LABEL}>{label}</span>
      <p className="type-body-r-s text-fg">{children}</p>
    </div>
  );
}

