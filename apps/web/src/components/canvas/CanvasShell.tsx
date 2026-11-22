"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, PanelLeftIcon, PanelRightIcon, SlidersHorizontalIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { AiChatPanel } from "./AiChatPanel";

interface CanvasShellProps {
  title: string;
  /**
   * Makes the name editable (a saved design). It gets the text as typed, on Enter or when the field loses focus;
   * the editor cleans it and may refuse it (a blank name), and the field then shows the title again.
   */
  onRename?(name: string): void;
  nameMaxLength?: number;
  /** The save state, next to the name. */
  status?: React.ReactNode;
  /** A notice under the top bar (a conflict, a deleted design). */
  banner?: React.ReactNode;
  /** Asked before "back to the dashboard" leaves: resolve true to go, false to stay. */
  onBeforeLeave?(): Promise<boolean>;
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

function NameField({ value, maxLength, onCommit, fill = false }: { value: string; maxLength?: number; onCommit(name: string): void; fill?: boolean }) {
  // The text typed is kept apart from the title until it is committed, so a refused name can simply fall back.
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  return (
    <Input
      aria-label="Design name"
      value={draft ?? value}
      maxLength={maxLength}
      className={cn("h-8 rounded-lg px-2 py-0 type-body-sb-s", fill ? "w-full" : "w-40 lg:w-56")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && !cancelled.current) onCommit(draft);
        cancelled.current = false;
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * The standalone Canvas layout: no dashboard sidebar. Layers and the right panel sit beside the
 * editor on large screens and open as sheets below that.
 */
export function CanvasShell({ title, onRename, nameMaxLength, status, banner, onBeforeLeave, toolbar, actions, layers, properties, propertiesSignal = 0, children }: CanvasShellProps) {
  const router = useRouter();
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
          onClick={async (e) => {
            // Leaving saves first. A click that opens a new tab or window is left alone.
            if (!onBeforeLeave || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            if (await onBeforeLeave()) router.push("/dashboard");
          }}
          className="flex shrink-0 items-center gap-2 rounded-lg p-1 text-fg outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <ArrowLeftIcon className="size-4 text-muted" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/posthivemain.png" alt="" className="size-7 rounded-lg" />
        </Link>
        <div className="hidden min-w-0 shrink-0 items-center sm:flex">
          {onRename ? <NameField value={title} maxLength={nameMaxLength} onCommit={onRename} /> : <p className="max-w-48 truncate type-body-sb-s text-fg">{title}</p>}
        </div>
        {/* Outside the wrapper above on purpose: a failing save must be visible on a narrow screen too (as an icon there). */}
        {status && <div className="flex shrink-0 items-center">{status}</div>}

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
      {/* Below sm the top bar has no room for the name, so it sits here, still renamable, with the note that the editor is built for
          a larger screen (it stays usable). */}
      <div data-testid="small-screen-bar" className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-surface px-3 py-2 sm:hidden">
        {onRename ? <NameField value={title} maxLength={nameMaxLength} onCommit={onRename} fill /> : <p className="truncate type-body-sb-s text-fg">{title}</p>}
        <p className="type-body-r-xs text-muted">Canvas works best on a larger screen. You can still edit here.</p>
      </div>
      {banner && <div className="shrink-0 border-b border-border bg-surface px-3 py-2">{banner}</div>}

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 border-r border-border bg-surface lg:block">{layers}</aside>
        <main className="relative min-w-0 flex-1 bg-background">{children}</main>
        <aside className="hidden w-80 shrink-0 border-l border-border bg-surface lg:block">{rightPanel}</aside>
      </div>
    </div>
  );
}
