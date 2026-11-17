"use client";

import { CanvasEditor } from "@/components/canvas/CanvasEditor";
import { CanvasGate } from "@/components/canvas/CanvasGate";
import { CanvasHome } from "@/components/canvas/CanvasHome";
import { CanvasFailure, CanvasWaiting } from "@/components/canvas/CanvasMessage";
import { useCanvasBootstrap } from "@/components/canvas/useCanvasBootstrap";

// The design team opens its saved designs here. Everyone else keeps the local, unsaved editor until the
// Marketing phase brings published templates. On the first open the loader in CanvasBoot covers this page;
// coming back from another Canvas page the loader is already gone, so the page shows its own quiet states.
export default function CanvasPage() {
  return <CanvasGate>{(isDesigner) => (isDesigner ? <CanvasHome /> : <LocalEditor />)}</CanvasGate>;
}

function LocalEditor() {
  const { engine, failure } = useCanvasBootstrap();
  if (failure) return <CanvasFailure message={failure.message} retry={failure.retry} />;
  if (!engine) return <CanvasWaiting />;
  return <CanvasEditor engine={engine} />;
}
