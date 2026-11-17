import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initialsOf } from "@/lib/dashboard-format";
import { activityLines, type ApiDesignActivity } from "@/lib/designer-dashboard";
import { DesignPanel } from "./DesignPanel";

type Props = {
  activities: ApiDesignActivity[];
  now: Date;
  /** The name of the person looking, for the events they did themselves. */
  you: string;
};

/**
 * "Recent Activities": what happened in the last week, newest first. Nothing logs events, so this is built from what the
 * posts and templates themselves remember (see designActivities in the API): a post keeps only its last send and review.
 */
export function DesignActivities({ activities, now, you }: Props) {
  return (
    <DesignPanel title="Recent Activities" action={<span className="type-body-r-xs text-neutral-500">Last 7 days</span>}>
      {activities.length === 0 ? (
        <p className="py-6 type-body-r-s text-neutral-500">No activity in the last 7 days.</p>
      ) : (
        <ul aria-label="Recent activities" className="flex flex-col gap-4.25">
          {activities.map((a, i) => {
            const { title, detail } = activityLines(a, now);
            return (
              <li key={`${a.kind}-${a.at}-${i}`} className="flex min-w-0 items-center gap-3">
                <Avatar className="rounded-xl">
                  <AvatarFallback className="rounded-xl bg-neutral-50 type-body-m-xs text-neutral-500">{initialsOf(a.mine ? you : a.by)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="truncate type-body-m-xs text-brand-950">{title}</p>
                  <p className="truncate type-body-r-xs text-neutral-500" title={detail}>
                    {detail}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </DesignPanel>
  );
}
