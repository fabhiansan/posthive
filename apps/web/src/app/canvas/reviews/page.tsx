"use client";

import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeftIcon, CircleAlertIcon, LockIcon } from "lucide-react";
import { useBootNone } from "@/components/canvas/CanvasBoot";
import { ReviewsWorkspace } from "@/components/canvas/ReviewsWorkspace";
import { useWorkspaceWait } from "@/components/canvas/useWorkspaceWait";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/Spinner";
import { usePermissions } from "@/lib/usePermissions";

// The design team's review queue (phase 6): the page, its access rules, and the workspace for the designer. The API enforces
// the same rule (owner and admin are refused too); this only chooses the screen.
export default function CanvasReviewsPage() {
  useBootNone();
  const { status, retry } = useWorkspaceWait();
  // The role is only the workspace's role once the workspace is there, so nothing is decided before that.
  const { canManageTemplates: isDesigner } = usePermissions();
  const ready = status === "ready";

  return (
    <div className="theme-dashboard flex h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/canvas">
            <ArrowLeftIcon /> Canvas
          </Link>
        </Button>
        <h1 className="type-body-sb-m text-fg">Design reviews</h1>
      </header>

      {ready && isDesigner ? (
        // useSearchParams (inside) needs the boundary
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center">
              <Spinner label="Loading the reviews" className="text-brand-800" />
            </div>
          }
        >
          <ReviewsWorkspace />
        </Suspense>
      ) : (
        <main className="flex min-h-0 flex-1 items-center justify-center p-6">
          {status === "timeout" ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CircleAlertIcon />
                </EmptyMedia>
                <EmptyTitle>Your workspace didn&apos;t load</EmptyTitle>
                <EmptyDescription>Check your connection and try again.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="secondary" onClick={retry}>
                  Try again
                </Button>
              </EmptyContent>
            </Empty>
          ) : !ready ? (
            <div className="flex items-center gap-2 type-body-r-s text-muted">
              <Spinner label="Loading your workspace" className="text-brand-800" /> Loading your workspace
            </div>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <LockIcon />
                </EmptyMedia>
                <EmptyTitle>Reviews are for the design team</EmptyTitle>
                <EmptyDescription>Designers approve submitted designs or ask for changes.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild variant="secondary">
                  <Link href="/canvas">Back to Canvas</Link>
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </main>
      )}
    </div>
  );
}
