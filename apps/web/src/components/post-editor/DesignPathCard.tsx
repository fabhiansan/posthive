"use client";

import { useState, type ReactNode } from "react";
import { PenToolIcon, LayoutTemplateIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";

type Path = "A" | "B";

type Props = {
  /** Which path opens first: worked out from the post, never stored. */
  initial: Path | null;
  /** Path A is off while a request is with the designer; Path B is off while the post cannot take a request. */
  disabledA?: string | null;
  disabledB?: string | null;
  pathA: ReactNode;
  pathB: ReactNode;
};

function Option({ path, on, title, hint, icon, reason, onPick }: { path: Path; on: boolean; title: string; hint: string; icon: ReactNode; reason?: string | null; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={Boolean(reason)}
      onClick={onPick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
        on ? "border-brand-500 bg-brand-100/60" : "border-border bg-surface hover:bg-neutral-50",
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-800" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block type-body-sb-s text-fg">Path {path} · {title}</span>
        <span className="block type-body-r-xs text-muted">{reason ?? hint}</span>
      </span>
      <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border-2", on ? "border-brand-600" : "border-neutral-300")}>
        {on && <span className="size-2.5 rounded-full bg-brand-600" />}
      </span>
    </button>
  );
}

/** Card B: how the design of this post is made. A template Marketing customises (A), or a designer who makes it (B). */
export function DesignPathCard({ initial, disabledA, disabledB, pathA, pathB }: Props) {
  const [picked, setPicked] = useState<Path | null>(null);
  // a path that is off cannot be the open one
  const open: Path | null = picked ?? initial;
  const shown: Path | null = open === "A" && disabledA ? null : open === "B" && disabledB ? null : open;

  return (
    <Card className="gap-4 border-0 p-5" role="region" aria-labelledby="path-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="path-heading" className="type-body-sb-m text-fg">B · Design path</h2>
        <p className="type-body-r-xs text-muted">Choose one before sending to Admin</p>
      </div>
      <div role="radiogroup" aria-labelledby="path-heading" className="flex flex-col gap-3">
        <Option path="A" on={shown === "A"} title="Use a template" hint="A template fits this content type. Pick one, then open it in the Studio." icon={<LayoutTemplateIcon className="size-5" />} reason={disabledA} onPick={() => setPicked("A")} />
        {shown === "A" && pathA}
        <Option path="B" on={shown === "B"} title="Assign to Designer" hint="No template yet? Send a design request to the design team." icon={<PenToolIcon className="size-5" />} reason={disabledB} onPick={() => setPicked("B")} />
        {shown === "B" && pathB}
      </div>
    </Card>
  );
}
