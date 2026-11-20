import Link from "next/link";
import { CalendarDaysIcon, CheckIcon, PlusIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ItemGroup, ItemSeparator } from "@/components/ui/item";
import { EmptyState } from "@/components/EmptyState";
import { formatTodayLong } from "@/lib/dashboard-format";
import { ChannelRow } from "./ChannelRow";
import { PostLine } from "./PostLine";
import { QuarterMilestones } from "./QuarterMilestones";
import { SectionPanel } from "./SectionPanel";
import type { DashboardData } from "./types";

type Props = {
  data: Pick<DashboardData, "plan" | "today" | "milestones" | "channels" | "tasksToday" | "taskRows">;
  today: Date;
  /** Whether the person's role opens the import page, which the empty milestones panel points to. */
  canImport?: boolean;
  /** A post of either list was clicked: open it in the drawer. Without it the rows are plain text. */
  onOpen?: (id: string) => void;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Posts a panel lists before "and N more": the panel is a glance, the Posts page has the rest. */
const SIDE_ROWS = 3;

/**
 * Today's publishing (posts a reviewer approved, or that were scheduled directly: out of draft), today's tasks (the drafts
 * dated today, still to be made, reviewed or fixed), the quarter's milestones and the channels: the right-hand column.
 */
export function SideColumn({ data, today, canImport = true, onOpen }: Props) {
  const { plan, today: publishToday, milestones, channels, tasksToday, taskRows } = data;
  const anyDisconnected = channels.some((c) => !c.connected);
  const connected = channels.filter((c) => c.connected).length;
  const publishRows = publishToday.rows.slice(0, SIDE_ROWS);
  const myRows = taskRows.slice(0, SIDE_ROWS);

  return (
    // min-w-0: a grid or flex child is as wide as its content unless told it may shrink
    <div className="flex min-w-0 flex-col gap-3">
      <SectionPanel
        title={`Today Publish, ${formatTodayLong(today)}`}
        action={<Badge variant="outline">{plural(publishToday.count, "post", "posts")}</Badge>}
      >
        {publishRows.length > 0 && (
          <ItemGroup className="gap-4">
            {publishRows.map((row) => (
              <PostLine key={row.id} row={row} kind="publish" onOpen={onOpen} />
            ))}
          </ItemGroup>
        )}
        {publishToday.count > publishRows.length && (
          <p className="mt-3 type-body-r-xs text-muted-foreground">and {publishToday.count - publishRows.length} more</p>
        )}
        {publishToday.count > 0 && (
          <Button asChild variant="outline-brand" className="mt-4 w-full">
            <Link href="/compose">
              <PlusIcon />
              Add Content
            </Link>
          </Button>
        )}
        {publishToday.count === 0 && (
          <EmptyState
            size="inline"
            icon={<CalendarDaysIcon />}
            title="Nothing publishing today"
            description="Posts approved and scheduled for today, and any that went out, show up here."
            action={
              <Button asChild variant="outline-brand" className="w-full">
                <Link href="/compose">
                  <PlusIcon />
                  Add content
                </Link>
              </Button>
            }
          />
        )}
      </SectionPanel>

      <SectionPanel
        title={tasksToday > 0 ? `Today's tasks · ${tasksToday}` : "Today's tasks"}
        action={
          <Button asChild variant="secondary" size="sm" className="rounded-full">
            <Link href="/jobs">View all</Link>
          </Button>
        }
      >
        {myRows.length > 0 && (
          <ItemGroup className="gap-4">
            {myRows.map((row) => (
              <PostLine key={row.id} row={row} kind="task" onOpen={onOpen} />
            ))}
          </ItemGroup>
        )}
        {tasksToday > myRows.length && (
          <p className="mt-3 type-body-r-xs text-muted-foreground">and {tasksToday - myRows.length} more</p>
        )}
        {tasksToday === 0 && (
          <EmptyState
            size="inline"
            icon={<CheckIcon />}
            title="No tasks today"
            description="Drafts dated for today show up here until they are approved and scheduled."
          />
        )}
      </SectionPanel>

      <QuarterMilestones quarter={plan.label} milestones={milestones} canImport={canImport} />

      <SectionPanel title="Channels this month" contentClassName="space-y-3">
        <ItemGroup className="gap-3">
          {channels.map((c, i) => (
            <div key={c.platform} className="space-y-3">
              {i > 0 && <ItemSeparator />}
              <ChannelRow channel={c} />
            </div>
          ))}
        </ItemGroup>
        {connected > 0 && plan.planned > 0 && (
          <p className="type-body-r-xs text-muted-foreground">
            {plural(plan.planned, "post", "posts")} planned across {plural(connected, "connected channel", "connected channels")} this quarter.
          </p>
        )}
        {anyDisconnected && <p className="type-body-r-xs text-muted-foreground">Connect a channel to start scheduling and publishing.</p>}
      </SectionPanel>
    </div>
  );
}

