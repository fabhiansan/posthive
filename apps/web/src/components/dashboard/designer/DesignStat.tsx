import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";

type Props = { value: number; label: string; note?: string; tone?: "good" | "bad" | "warn" };

const TONE = { good: "text-green-800", bad: "text-red-500", warn: "text-brand-800" } as const;

/** A number over its name and a quiet line: the four cards under the greeting of the design team's pages. */
export function DesignStat({ value, label, note, tone }: Props) {
  return (
    <Card className="gap-0 border-0 px-4 pt-5 pb-4">
      <p className={cn("type-head-r-4 tabular-nums", tone ? TONE[tone] : "text-brand-950")}>{value}</p>
      <h2 className="type-body-r-xs text-neutral-500">{label}</h2>
      {note && <p className="mt-1 type-body-r-xs text-neutral-500/70">{note}</p>}
    </Card>
  );
}
