import { LayersIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

// Phase 2 fills this with the document's layers: visibility, order and rename.
export function LayersPanel() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <h2 className="flex h-12 shrink-0 items-center border-b border-border px-4 type-body-sb-s text-fg">Layers</h2>
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayersIcon />
          </EmptyMedia>
          <EmptyTitle>No layers yet</EmptyTitle>
          <EmptyDescription>Shapes, text and images you add will be listed here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
