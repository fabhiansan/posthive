import { ProfileSection } from "@/components/profile/ProfileSection";
import { cn } from "@/lib/cn";
import type { ActivityCount } from "@/lib/profile-mock";

type Props = {
  /** "Q4 2026" */
  quarter: string;
  /** "1 January" */
  resets: string;
  counts: ActivityCount[];
};

/** Your activity: what the person did this quarter. The first row is the one that counts most, so it is drawn bigger. */
export function ActivityCard({ quarter, resets, counts }: Props) {
  return (
    <ProfileSection title="Your activity" note={quarter} className="pt-4.5">
      <ol className="space-y-4.25">
        {counts.map((row, i) => (
          <li key={row.id} className="flex items-center gap-3">
            <span
              className={cn(
                "grid size-5.5 shrink-0 place-items-center rounded-full tabular-nums",
                i === 0 ? "border border-brand-700 bg-brand-500 type-body-sb-xxs text-neutral-950" : "bg-red-50 type-body-r-xxs text-neutral-300"
              )}
            >
              {row.count}
            </span>
            <div className="min-w-0">
              <p className={cn(i === 0 ? "type-body-m-s text-fg" : "type-body-m-xs text-neutral-600")}>{row.title}</p>
              <p className="type-body-r-xxs text-neutral-500">{row.note}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="type-body-r-xxs text-brand-800">Counts cover the current quarter and reset on {resets}.</p>
    </ProfileSection>
  );
}
