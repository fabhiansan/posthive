import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";

type Props = {
  title: string;
  /** Right side of the header: a note, or a button. The title is centred on it. */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
};

/**
 * A white card of the designer's dashboard: a 14px title, a note or a button on its right, then the content. The
 * marketing dashboard's SectionPanel has a 16px title and 16px padding; this design has 14px and 20px.
 */
export function DesignPanel({ title, action, className, children }: Props) {
  return (
    <Card className={cn("min-w-0 gap-4 border-0 px-5 py-5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="type-body-sb-s text-brand-950">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}
