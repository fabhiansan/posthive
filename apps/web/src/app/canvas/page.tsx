"use client";

import { CanvasEditor } from "@/components/canvas/CanvasEditor";
import { useCanvasBootstrap } from "@/components/canvas/useCanvasBootstrap";
import { Spinner } from "@/components/Spinner";

// Phase 2: a working editor on a local, unsaved design. On the first open the loader in CanvasBoot
// covers this page. Coming back from another Canvas page the loader is already gone, so the page
// shows its own quiet spinner until the engine and fonts are ready.
export default function CanvasPage() {
  const engine = useCanvasBootstrap();
  if (!engine) {
    return (
      <div className="theme-dashboard flex h-dvh items-center justify-center bg-background">
        <Spinner size="lg" label="Loading the editor" className="text-brand-800" />
      </div>
    );
  }
  return <CanvasEditor engine={engine} />;
}
