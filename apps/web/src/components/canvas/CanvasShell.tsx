"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, PanelLeftIcon, PanelRightIcon, SlidersHorizontalIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AiChatPanel } from "./AiChatPanel";

interface CanvasShellProps {
  title: string;
  /** Tools, undo/redo and zoom: the centre of the top bar. */
  toolbar: React.ReactNode;
  /** Right end of the top bar (export). */
  actions: React.ReactNode;
  layers: React.ReactNode;
  properties: React.ReactNode;
  /** Changes whenever the Properties tab should come forward (a double-click on text). */
  propertiesSignal?: number;
  /** The editor surface. It fills the space between the panels. */
  children: React.ReactNode;
}

/**
 * The standalone Canvas layout: no dashboard sidebar. Layers and the right panel sit beside the
 * editor on large screens and open as sheets below that.
 */
export function CanvasShell({ title, toolbar, actions, layers, properties, propertiesSignal = 0, children }: CanvasShellProps) {
  const [tab, setTab] = useState("properties");
  useEffect(() => {
    if (propertiesSignal > 0) setTab("properties");
  }, [propertiesSignal]);

  // The right panel is rendered twice (beside the editor, and inside the narrow-screen sheet), both from one tab state.
  const rightPanel = (
    <Tabs value={tab} onValueChange={setTab} className="h-full min-h-0 gap-0">
      <TabsList variant="line" className="shrink-0 px-2">
        <TabsTrigger value="properties">
          <SlidersHorizontalIcon /> Properties
        </TabsTrigger>
        <TabsTrigger value="assistant">
          <SparklesIcon /> Assistant
        </TabsTrigger>
      </TabsList>
      {/* Both tabs stay mounted, so switching tabs keeps a half-typed message. The narrow-screen sheet
          unmounts when it closes and loses it, which is fine while the placeholder cannot send. */}
      <TabsContent value="properties" forceMount className="flex min-h-0 flex-col overflow-y-auto data-[state=inactive]:hidden">
        {properties}
      </TabsContent>
      <TabsContent value="assistant" forceMount className="flex min-h-0 flex-col data-[state=inactive]:hidden">
        <AiChatPanel />
      </TabsContent>
    </Tabs>
  );

  return (
    <div className="theme-dashboard flex h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
        <Link
          href="/dashboard"
          aria-label="Back to dashboard"
          className="flex shrink-0 items-center gap-2 rounded-lg p-1 text-fg outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <ArrowLeftIcon className="size-4 text-muted" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/posthivemain.png" alt="" className="size-7 rounded-lg" />
        </Link>
        <p className="hidden min-w-0 max-w-48 truncate type-body-sb-s text-fg sm:block">{title}</p>

        <div role="toolbar" aria-label="Tools" className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto">
          {toolbar}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Layers" className="lg:hidden">
                <PanelLeftIcon />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 gap-0 p-0">
              <SheetTitle className="sr-only">Layers</SheetTitle>
              {layers}
            </SheetContent>
          </Sheet>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Properties and assistant" className="lg:hidden">
                <PanelRightIcon />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="gap-0 p-0">
              <SheetTitle className="sr-only">Properties and assistant</SheetTitle>
              {rightPanel}
            </SheetContent>
          </Sheet>
          {actions}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 border-r border-border bg-surface lg:block">{layers}</aside>
        <main className="relative min-w-0 flex-1 bg-background">{children}</main>
        <aside className="hidden w-80 shrink-0 border-l border-border bg-surface lg:block">{rightPanel}</aside>
      </div>
    </div>
  );
}
