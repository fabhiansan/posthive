"use client";

import { useMemo } from "react";
import { RefreshCwIcon } from "lucide-react";
import { InlineAlert } from "@/components/InlineAlert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useContentActions } from "@/components/content-list/useContentActions";
import { Topbar } from "@/components/dashboard/Topbar";
import { useAuth } from "@/context/AuthContext";
import { BRAND } from "@/lib/brand";
import { firstName, greetingFor } from "@/lib/dashboard-format";
import { designSubtitle, templateTotals, type ApiDesignDashboard } from "@/lib/designer-dashboard";
import { useDashboard } from "@/lib/useDashboard";
import { DesignActivities } from "./DesignActivities";
import { DesignQueue } from "./DesignQueue";
import { DesignStat } from "./DesignStat";
import { TemplatePillars } from "./TemplatePillars";

const NO_QUEUE: ApiDesignDashboard["queue"] = [];

/**
 * The dashboard of the design team (docs/design/designer-dashboard.png): the designs waiting for review, the counts around
 * them, what happened lately and the templates. For now every design of the workspace waiting for review is listed, not only
 * the ones assigned to this designer: "assign to designer" in add/edit content is not built yet.
 */
export function DesignerDashboard() {
  const { user } = useAuth();
  const now = useMemo(() => new Date(), []);
  const { data, loading, error, reload } = useDashboard<ApiDesignDashboard>("/dashboard/design");
  // "Review design" opens the same review dialog as the drawer's Review button; an answer asks the numbers again
  const actions = useContentActions({ rows: data?.queue ?? NO_QUEUE, reload });

  const first = firstName(user?.name);
  const templates = data ? templateTotals(data.templates) : null;
  let subtitle = "Loading your workspace…";
  if (data && templates) subtitle = designSubtitle(data.pending, templates.draft);
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
              <DesignStat value={data.pending} label="Pending Approvals" note="Designs waiting for your review" />
              <DesignStat value={data.approved} label="Approved Designs" note="Approved this quarter" tone="good" />
              <DesignStat value={data.revision} label="Revision Required" note="Sent back to Marketing" tone="bad" />
              <DesignStat value={templates.total} label="Total Templates" note={`${templates.published} published · ${templates.draft} draft`} />
            </div>

            <DesignQueue
              posts={data.queue}
              pending={data.pending}
              revision={data.revision}
              approved={data.approved}
              now={now}
              onOpen={actions.open}
              onReview={actions.review}
            />

            {/* the two cards are as tall as each other, as in the design */}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_--spacing(105)]">
              <DesignActivities activities={data.activities} now={now} you={user?.name ?? ""} />
              <TemplatePillars templates={data.templates} />
            </div>
          </>
        )}
      </div>

      {actions.layer}
    </div>
  );
}
