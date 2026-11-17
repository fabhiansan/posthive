"use client";

import { useParams } from "next/navigation";
import { FileQuestionIcon, LockIcon } from "lucide-react";
import { useBootNone } from "@/components/canvas/CanvasBoot";
import { CanvasEditor } from "@/components/canvas/CanvasEditor";
import { CanvasGate } from "@/components/canvas/CanvasGate";
import { CanvasFailure, CanvasMessage, CanvasWaiting } from "@/components/canvas/CanvasMessage";
import { useCanvasBootstrap } from "@/components/canvas/useCanvasBootstrap";

// A saved design, opened for editing. Only the design team has designs; the API refuses everyone else, and this
// page does not even ask. Keyed by the id, so moving from one design to another starts everything afresh.
export default function CanvasDesignPage() {
  const { designId } = useParams<{ designId: string }>();
  return <CanvasGate>{(isDesigner) => (isDesigner ? <DesignScreen key={designId} designId={designId} /> : <DesignTeamOnly />)}</CanvasGate>;
}

function DesignTeamOnly() {
  useBootNone(); // nothing to load, so the first-open loader can go
  return <CanvasMessage icon={<LockIcon />} title="Designs are for the design team" description="Designers create and edit designs here." />;
}

function DesignScreen({ designId }: { designId: string }) {
  const { engine, design, problem, failure } = useCanvasBootstrap(designId);
  if (problem === "not-found") {
    return <CanvasMessage icon={<FileQuestionIcon />} title="This design doesn't exist" description="It may have been deleted, or the address is wrong." />;
  }
  if (problem === "forbidden") {
    return <CanvasMessage icon={<LockIcon />} title="Designs are for the design team" description="Designers create and edit designs here." />;
  }
  if (problem === "invalid") {
    return <CanvasMessage icon={<FileQuestionIcon />} title="This design can't be opened" description="Its saved content is not in a format this editor understands." />;
  }
  if (failure) return <CanvasFailure message={failure.message} retry={failure.retry} />;
  if (!engine || !design) return <CanvasWaiting />;
  return <CanvasEditor engine={engine} design={design} />;
}
