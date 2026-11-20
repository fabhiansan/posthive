"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { FileQuestionIcon, LockIcon } from "lucide-react";
import { useBootNone } from "@/components/canvas/CanvasBoot";
import { CanvasEditor } from "@/components/canvas/CanvasEditor";
import { CanvasGate } from "@/components/canvas/CanvasGate";
import { CanvasFailure, CanvasMessage, CanvasWaiting } from "@/components/canvas/CanvasMessage";
import { InstanceEditor } from "@/components/canvas/InstanceEditor";
import { SubmissionHistory } from "@/components/canvas/SubmissionHistory";
import { instanceSource, useCanvasBootstrap, useOpenedDesign } from "@/components/canvas/useCanvasBootstrap";
import { listSubmissions, type InstanceDetail } from "@/lib/canvas";
import { usePermissions } from "@/lib/usePermissions";

// One saved design, opened for editing. The address is the design's id, and what it opens depends on who is asking: the design
// team opens a template design, Marketing (owner, admin, member) opens its own design made from a published template. Each role's
// API answers 404 for the other kind of design, so an id of the wrong kind is just "doesn't exist". The API enforces all of it;
// this only chooses the screen. Keyed by the id, so moving from one design to another starts everything afresh.
export default function CanvasDesignPage() {
  const { designId } = useParams<{ designId: string }>();
  return <CanvasGate>{(isDesigner) => (isDesigner ? <DesignScreen key={designId} designId={designId} /> : <ForMarketing key={designId} designId={designId} />)}</CanvasGate>;
}

function ForMarketing({ designId }: { designId: string }) {
  const { canEditContent } = usePermissions();
  return canEditContent ? <InstanceScreen designId={designId} /> : <DesignTeamOnly />;
}

function DesignTeamOnly() {
  useBootNone(); // nothing to load, so the first-open loader can go
  return <CanvasMessage icon={<LockIcon />} title="Designs are for the design team" description="Designers create and edit designs here." />;
}

const gone = <CanvasMessage icon={<FileQuestionIcon />} title="This design doesn't exist" description="It may have been deleted, or the address is wrong." />;

function DesignScreen({ designId }: { designId: string }) {
  const { engine, design, problem, failure } = useCanvasBootstrap(designId);
  if (problem === "not-found") return gone;
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

// ?view=history opens what the person submitted for this design (it works for an archived design too); anything else opens the editor.
function InstanceScreen({ designId }: { designId: string }) {
  const history = useSearchParams().get("view") === "history";
  return history ? <SubmissionHistory designId={designId} /> : <InstanceEditorScreen designId={designId} />;
}

/**
 * The editor answered 404. That is "doesn't exist" for another person's design, a template's design or one that was deleted,
 * and "archived" for one of mine that was submitted (it is frozen, not gone): the way to tell is that it has a history.
 */
function ArchivedOrGone({ designId }: { designId: string }) {
  const [kind, setKind] = useState<"checking" | "archived" | "gone" | "failed">("checking");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    listSubmissions(designId).then(
      () => live && setKind("archived"),
      (err: unknown) => live && setKind((err as { status?: number } | null)?.status === 404 ? "gone" : "failed"),
    );
    return () => {
      live = false;
    };
  }, [designId, attempt]);
  if (kind === "checking") return <CanvasWaiting />;
  if (kind === "failed") {
    return (
      <CanvasFailure
        message="Check your connection and try again."
        retry={() => {
          setKind("checking");
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  return kind === "archived" ? <SubmissionHistory designId={designId} /> : gone;
}

function InstanceEditorScreen({ designId }: { designId: string }) {
  const { engine, design, problem, failure } = useOpenedDesign<InstanceDetail>(designId, instanceSource);
  if (problem === "not-found") return <ArchivedOrGone designId={designId} />;
  if (problem === "forbidden") {
    return <CanvasMessage icon={<LockIcon />} title="You can't open this design" description="Designs are made from published templates by Marketing and Admin." />;
  }
  if (problem === "invalid") {
    return <CanvasMessage icon={<FileQuestionIcon />} title="This design can't be opened" description="Its saved content is not in a format this editor understands." />;
  }
  if (failure) return <CanvasFailure message={failure.message} retry={failure.retry} />;
  if (!engine || !design) return <CanvasWaiting />;
  return <InstanceEditor engine={engine} instance={design} />;
}
