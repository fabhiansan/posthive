"use client";

import Link from "next/link";
import {
  ArrowLeftIcon,
  CircleIcon,
  DownloadIcon,
  ImagePlusIcon,
  MousePointer2Icon,
  PanelLeftIcon,
  PanelRightIcon,
  Redo2Icon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquareIcon,
  TypeIcon,
  Undo2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { AiChatPanel } from "./AiChatPanel";
import { Inspector } from "./Inspector";
import { LayersPanel } from "./LayersPanel";

interface CanvasShellProps {
  title: string;
  artboard: { width: number; height: number };
  /** The editor surface. It fills the space between the panels. */
  children: React.ReactNode;
}

// The tools are laid out now so the toolbar doesn't move when Phase 2 switches them on.
const TOOLS = [
  { label: "Select", icon: MousePointer2Icon },
  { label: "Rectangle", icon: SquareIcon },
  { label: "Ellipse", icon: CircleIcon },
  { label: "Text", icon: TypeIcon },
  { label: "Image", icon: ImagePlusIcon },
];

function RightPanel({ artboard }: { artboard: CanvasShellProps["artboard"] }) {
  return (
    <Tabs defaultValue="properties" className="h-full min-h-0 gap-0">
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
      <TabsContent value="properties" forceMount className="flex min-h-0 flex-col data-[state=inactive]:hidden">
        <Inspector width={artboard.width} height={artboard.height} />
      </TabsContent>
      <TabsContent value="assistant" forceMount className="flex min-h-0 flex-col data-[state=inactive]:hidden">
        <AiChatPanel />
      </TabsContent>
    </Tabs>
  );
}

/**
 * The standalone Canvas layout: no dashboard sidebar. Layers and the right panel sit beside the
 * editor on large screens and open as sheets below that.
 */
export function CanvasShell({ title, artboard, children }: CanvasShellProps) {
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
          {TOOLS.map(({ label, icon: Icon }, i) => (
            <Button
              key={label}
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              aria-pressed={i === 0}
              disabled={i !== 0}
              className={cn(i === 0 && "bg-brand-100 text-brand-800 hover:bg-brand-100 hover:text-brand-800")}
            >
              <Icon />
            </Button>
          ))}
          <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
          <Button variant="ghost" size="icon-sm" aria-label="Undo" disabled>
            <Undo2Icon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Redo" disabled>
            <Redo2Icon />
          </Button>
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
              <LayersPanel />
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
              <RightPanel artboard={artboard} />
            </SheetContent>
          </Sheet>
          <Button variant="secondary" size="sm" disabled>
            <DownloadIcon /> Export
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 border-r border-border bg-surface lg:block">
          <LayersPanel />
        </aside>
        <main className="relative min-w-0 flex-1 bg-background">{children}</main>
        <aside className="hidden w-80 shrink-0 border-l border-border bg-surface lg:block">
          <RightPanel artboard={artboard} />
        </aside>
      </div>
    </div>
  );
}
