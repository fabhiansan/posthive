"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, CircleIcon, EyeIcon, EyeOffIcon, ImageIcon, LayersIcon, SquareIcon, TypeIcon } from "lucide-react";
import type { CanvasNode, MoveTo, NodeType } from "posthive-canvas";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

const ICONS: Record<NodeType, typeof SquareIcon> = { rect: SquareIcon, ellipse: CircleIcon, text: TypeIcon, image: ImageIcon, group: LayersIcon };

interface LayersPanelProps {
  /** In paint order (first = bottom). The panel lists them top first, like every design tool. */
  nodes: readonly CanvasNode[];
  selectedId: string | null;
  onSelect(id: string): void;
  onToggleVisible(id: string): void;
  onMove(id: string, to: MoveTo): void;
  onRename(id: string, name: string): void;
  /** The longest layer name (LIMITS.nodeName.max). */
  nameMaxLength: number;
}

function RenameField({ name, maxLength, onDone }: { name: string; maxLength: number; onDone(next: string | null): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false); // Enter and the blur it causes must not both commit
  useEffect(() => ref.current?.select(), []);
  const finish = (next: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(next);
  };
  return (
    <Input
      ref={ref}
      defaultValue={name}
      maxLength={maxLength}
      aria-label="Layer name"
      className="h-7 rounded-lg px-2 py-0"
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(null);
      }}
    />
  );
}

export function LayersPanel({ nodes, selectedId, onSelect, onToggleVisible, onMove, onRename, nameMaxLength }: LayersPanelProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const top = nodes.length - 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h2 className="flex h-12 shrink-0 items-center border-b border-border px-4 type-body-sb-s text-fg">Layers</h2>
      {nodes.length === 0 ? (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayersIcon />
            </EmptyMedia>
            <EmptyTitle>No layers yet</EmptyTitle>
            <EmptyDescription>Shapes, text and images you add will be listed here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {nodes
            .map((node, index) => ({ node, index }))
            .reverse()
            .map(({ node, index }) => {
              const Icon = ICONS[node.type];
              const active = node.id === selectedId;
              return (
                <li
                  key={node.id}
                  className={cn("flex items-center gap-1 rounded-lg pr-1", active ? "bg-brand-100 text-brand-800" : "text-fg hover:bg-neutral-100")}
                >
                  {renaming === node.id ? (
                    <div className="min-w-0 flex-1 p-1">
                      <RenameField
                        name={node.name}
                        maxLength={nameMaxLength}
                        onDone={(next) => {
                          setRenaming(null);
                          if (next !== null && next.trim() && next !== node.name) onRename(node.id, next.trim());
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-pressed={active}
                      title="Double-click or press F2 to rename"
                      onClick={() => onSelect(node.id)}
                      onDoubleClick={() => setRenaming(node.id)}
                      onKeyDown={(e) => e.key === "F2" && setRenaming(node.id)}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                        !node.visible && "opacity-50",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate type-body-m-s">{node.name}</span>
                    </button>
                  )}
                  {active && renaming !== node.id && (
                    <>
                      <Button variant="ghost" size="icon-sm" aria-label="Bring forward" disabled={index === top} onClick={() => onMove(node.id, "up")}>
                        <ChevronUpIcon />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label="Send backward" disabled={index === 0} onClick={() => onMove(node.id, "down")}>
                        <ChevronDownIcon />
                      </Button>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={node.visible ? `Hide ${node.name}` : `Show ${node.name}`}
                    aria-pressed={!node.visible}
                    onClick={() => onToggleVisible(node.id)}
                  >
                    {node.visible ? <EyeIcon /> : <EyeOffIcon />}
                  </Button>
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}
