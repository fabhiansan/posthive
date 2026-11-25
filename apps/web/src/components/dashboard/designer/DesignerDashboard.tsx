"use client";

import { useMemo } from "react";
import { RefreshCwIcon } from "lucide-react";
import { InlineAlert } from "@/components/InlineAlert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Topbar } from "@/components/dashboard/Topbar";
import { useAuth } from "@/context/AuthContext";
import { BRAND } from "@/lib/brand";
import { firstName, greetingFor } from "@/lib/dashboard-format";
import { templateTotals, type ApiDesignDashboard } from "@/lib/designer-dashboard";
import { dashboardSubtitle } from "@/lib/design-tasks";
import { useDashboard } from "@/lib/useDashboard";
import { DesignActivities } from "./DesignActivities";
import { DesignStat } from "./DesignStat";
import { DesignTasks } from "./DesignTasks";
import { TemplatePillars } from "./TemplatePillars";

/**
 * The dashboard of the design team (docs/design/designer/dashboard.png): the tasks Marketing assigned to this designer, the
 * counts around them, what happened lately and the templates. Approving is the admin's, so nothing here waits for a review.
 */
export function DesignerDashboard() {
  const { user } = useAuth();
  const now = useMemo(() => new Date(), []);
  const { data, loading, error, reload } = useDashboard<ApiDesignDashboard>("/dashboard/design");

  const first = firstName(user?.name);
  const templates = data ? templateTotals(data.templates) : null;
  let subtitle = "Loading your workspace…";
  if (data && templates) subtitle = dashboardSubtitle(data.counts, templates.draft);
  else if (!loading) subtitle = "We couldn't load your workspace.";

  return (
    // The shell clips its content, so the page scrolls inside this box
    <div className="theme-dashboard flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-[110rem] flex-col gap-4 p-4 pt-16 md:p-6 md:pt-6">
        <Topbar
          greeting={`${greetingFor(now)}${first ? `, ${first}` : ""}`}
          firstName={first}
          fullName={user?.name ?? ""}
          avatarUrl={user?.avatarUrl}
          brand={BRAND.name}
          subtitle={subtitle}
          subtitleClassName="type-body-r-s text-brand-950"
          today={now}
        />

        {error && (
          <InlineAlert tone="danger" title={data ? "Couldn't refresh the dashboard" : "Couldn't load the dashboard"}>
            {error}{" "}
            <Button variant="link" size="sm" className="inline-flex h-auto p-0" onClick={reload}>
              <RefreshCwIcon /> Try again
            </Button>
            {data && " Showing what was loaded before."}
          </InlineAlert>
        )}

        {!data && loading && (
          <div aria-busy="true" aria-label="Loading the dashboard" className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Skeleton className="h-28 rounded-2xl" />
              <Skeleton className="h-28 rounded-2xl" />
              <Skeleton className="h-28 rounded-2xl" />
              <Skeleton className="h-28 rounded-2xl" />
            </div>
            <Skeleton className="h-96 w-full rounded-2xl" />
          </div>
        )}

        {data && templates && (
          <>
            {/* grid-cols-1 is minmax(0, 1fr): without it the single column is as wide as its widest content and the page scrolls sideways */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <DesignStat value={data.counts.assigned + data.counts.progress} label="Assigned to me" note="Posts from Marketing" />
              <DesignStat value={data.counts.progress} label="In progress" note="Figma work started" tone="good" />
              <DesignStat value={data.counts.waiting} label="Done · waiting for Marketing" note="Sent, not yet in review" tone="warn" />
              <DesignStat value={templates.total} label="Total Templates" note={`${templates.published} published · ${templates.draft} draft`} />
            </div>

            <DesignTasks tasks={data.tasks} counts={data.counts} now={now} />

            {/* the two cards are as tall as each other, as in the design */}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_--spacing(105)]">
              <DesignActivities activities={data.activities} now={now} you={user?.name ?? ""} />
              <TemplatePillars templates={data.templates} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
