"use client";

import Link from "next/link";
import { ArrowLeftIcon, CircleAlertIcon, ClipboardCheckIcon, LockIcon } from "lucide-react";
import { useBootNone } from "@/components/canvas/CanvasBoot";
import { useWorkspaceWait } from "@/components/canvas/useWorkspaceWait";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/Spinner";
import { usePermissions } from "@/lib/usePermissions";

// Phase 1: the page and its access rules. The queue itself arrives with the review phase.
export default function CanvasReviewsPage() {
  useBootNone();
  const { status, retry } = useWorkspaceWait();
  // The role is only the workspace's role once the workspace is there, so nothing is decided before that.
  const { canManageTemplates: isDesigner } = usePermissions();

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
        ) : status !== "ready" ? (
          <div className="flex items-center gap-2 type-body-r-s text-muted">
            <Spinner label="Loading your workspace" className="text-brand-800" /> Loading your workspace
          </div>
        ) : isDesigner ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ClipboardCheckIcon />
              </EmptyMedia>
              <EmptyTitle>No designs are waiting for review</EmptyTitle>
              <EmptyDescription>
                When Marketing submits a design, it appears here for you to approve or send back with comments.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
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
    </div>
  );
}
