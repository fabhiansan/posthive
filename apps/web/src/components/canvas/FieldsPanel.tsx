"use client";

import { ImageIcon, LockIcon, TypeIcon } from "lucide-react";
import type { CanvasNode } from "posthive-canvas";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/cn";

export interface FieldRow {
  nodeId: string;
  kind: "text" | "image";
  /** The layer's name in the design. */
  name: string;
  /** Marketing has changed this field from the published revision. */
  changed: boolean;
}

interface FieldsPanelProps {
  fields: readonly FieldRow[];
  /** How many layers the design team locked (everything the revision does not list). Said once, never listed. */
  lockedCount: number;
  selectedId: string | null;
  onSelect(id: string): void;
}

/**
 * What Marketing may change in this design: the editable fields only, in paint order. A locked layer is never listed
 * (there is nothing to do with it), and the count says how many there are so the design does not look incomplete.
 */
export function FieldsPanel({ fields, lockedCount, selectedId, onSelect }: FieldsPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <h2 className="flex h-12 shrink-0 items-center border-b border-border px-4 type-body-sb-s text-fg">Fields</h2>
      {fields.length === 0 ? (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing to change</EmptyTitle>
            <EmptyDescription>The design team has not opened any text or image of this design to Marketing. You can still look at it and export it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {[...fields].reverse().map((f) => {
            const Icon = f.kind === "text" ? TypeIcon : ImageIcon;
            const active = f.nodeId === selectedId;
            return (
              <li key={f.nodeId}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelect(f.nodeId)}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    active ? "bg-brand-100 text-brand-800" : "text-fg hover:bg-neutral-100",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate type-body-m-s">{f.name}</span>
                  {f.changed && (
                    <>
                      <span aria-hidden className="ml-auto size-2 shrink-0 rounded-full bg-brand-500" />
                      <span className="sr-only">Changed</span>
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {lockedCount > 0 && (
        <p className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3 type-body-r-xs text-muted">
          <LockIcon aria-hidden className="size-3.5 shrink-0" />
          {lockedCount === 1 ? "1 layer is" : `${lockedCount} layers are`} locked by the design team.
        </p>
      )}
    </div>
  );
}
