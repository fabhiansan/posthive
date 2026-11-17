import { ProfileSection } from "@/components/profile/ProfileSection";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { activityLines, type ApiActivity } from "@/lib/profile-security";

type Props = {
  /** "Q4 2026" */
  quarter: string;
  /** "1 January" */
  resets: string;
  data: ApiActivity | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
};

/** Your activity: what the person did this quarter. The first row is the one that counts most, so it is drawn bigger. */
export function ActivityCard({ quarter, resets, data, loading, error, onRetry }: Props) {
  const lines = data ? activityLines(data.rows) : [];
  return (
    <ProfileSection title="Your activity" note={quarter} className="pt-4.5">
      {!data && loading && (
        <div aria-busy="true" aria-label="Loading your activity" className="space-y-4.25">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full rounded-lg" />
          ))}
        </div>
      )}

      {!data && !loading && error && (
        <p role="alert" className="type-body-r-xs text-red-600">
          We couldn&apos;t load your activity.{" "}
          <button type="button" onClick={onRetry} className="underline underline-offset-2">
            Try again
          </button>
        </p>
      )}

      {data && (
        <>
          <ol className="space-y-4.25">
            {lines.map((row, i) => (
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
        </>
      )}
    </ProfileSection>
  );
}
