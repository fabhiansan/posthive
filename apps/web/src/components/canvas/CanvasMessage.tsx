"use client";

import Link from "next/link";
import { ArrowLeftIcon, CircleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/Spinner";

/** A Canvas page that has something to say instead of an editor: a design that is gone, a screen for the design team only. */
export function CanvasMessage({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children?: React.ReactNode }) {
  return (
    <div className="theme-dashboard flex h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/canvas">
            <ArrowLeftIcon /> Canvas
          </Link>
        </Button>
      </header>
      <main className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">{icon}</EmptyMedia>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{description}</EmptyDescription>
          </EmptyHeader>
          {children && <EmptyContent>{children}</EmptyContent>}
        </Empty>
      </main>
    </div>
  );
}

/** Something that may work on a second try. The first-open loader shows the same error, but it is gone after the first open. */
export function CanvasFailure({ message, retry }: { message: string; retry: () => void }) {
  return (
    <CanvasMessage icon={<CircleAlertIcon />} title="Canvas didn't open" description={message}>
      <Button variant="secondary" onClick={retry}>
        Try again
      </Button>
    </CanvasMessage>
  );
}

/** A quiet spinner for the moments the first-open loader is not covering the page (coming back from another Canvas page). */
export function CanvasWaiting() {
  return (
    <div className="theme-dashboard flex h-dvh items-center justify-center bg-background">
      <Spinner size="lg" label="Loading the editor" className="text-brand-800" />
    </div>
  );
}
