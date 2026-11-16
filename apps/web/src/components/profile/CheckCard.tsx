import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/cn";

type Props = {
  title: string;
  /** What a screen reader calls the checkbox when the title alone is not enough (two accounts of one platform). */
  label?: string;
  note?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Something between the checkbox and the text: the icon of an account. */
  media?: ReactNode;
};

/**
 * A row you tick, drawn as a card: yellow edge and tint when it is on, plain white when it is off.
 * The design's tick box is yellow with a check when on and solid olive when off, so that is what
 * the checkbox gets here.
 */
export function CheckCard({ title, label, note, checked, onCheckedChange, media }: Props) {
  return (
    <label
      className={cn(
        "flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border px-3 py-3",
        checked ? "border-brand-500 bg-brand-50" : "border-border bg-surface"
      )}
    >
      <Checkbox
        aria-label={label ?? title}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="border-neutral-700 bg-neutral-700 data-[state=checked]:border-brand-500 data-[state=checked]:bg-brand-500"
      />
      {media}
      <span className="min-w-0">
        <span className="block truncate type-body-m-s text-fg">{title}</span>
        {note && <span className="block type-body-r-xxs text-neutral-500">{note}</span>}
      </span>
    </label>
  );
}
