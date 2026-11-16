import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";

type Props = {
  title: ReactNode;
  /** The quiet note at the right of the title: "Visible to people in your workspace". */
  note?: ReactNode;
  /** Replaces the note when the corner holds a button ("Sign out of other devices"). */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
};

/** A white card of My Profile: a title with a note or a button at its right, then the content. */
export function ProfileSection({ title, note, action, className, children }: Props) {
  return (
    <Card className={cn("min-w-0 gap-3.5 border-0 px-5", className)}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="min-w-0 type-body-sb-s text-fg">{title}</h2>
        {action ?? (note && <p className="min-w-0 text-right type-body-r-xs text-neutral-500">{note}</p>)}
      </header>
      {children}
    </Card>
  );
}
