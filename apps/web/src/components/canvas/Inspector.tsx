import { SlidersHorizontalIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

interface InspectorProps {
  width: number;
  height: number;
}

// Phase 2 swaps the empty state for the selected layer's position, size, fill and text controls.
export function Inspector({ width, height }: InspectorProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-b border-border px-4 py-3 type-body-r-s">
        <dt className="text-muted">Canvas size</dt>
        <dd className="text-right text-fg">{width} × {height} px</dd>
      </dl>
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SlidersHorizontalIcon />
          </EmptyMedia>
          <EmptyTitle>Nothing selected</EmptyTitle>
          <EmptyDescription>Select a layer to change its position, size and style.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
