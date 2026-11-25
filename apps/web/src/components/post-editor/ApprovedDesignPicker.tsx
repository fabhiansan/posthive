"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasStageHandle } from "posthive-canvas";
import { ArchiveIcon } from "lucide-react";
import { ReadOnlyStage } from "@/components/canvas/ReadOnlyStage";
import { assetIdsOf, useOpenedDesign, type DesignSource } from "@/components/canvas/useCanvasBootstrap";
import { EmptyState } from "@/components/EmptyState";
import { InlineAlert } from "@/components/InlineAlert";
import { Modal } from "@/components/Modal";
import { Spinner } from "@/components/Spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { canvasProblem, formatWhen, getSubmission, listApprovedDesigns, uploadDesignImage, type ApprovedDesign, type SubmissionDetail } from "@/lib/canvas";
import { cn } from "@/lib/cn";

/** Said word for word wherever an approved design is offered (roadmap T-2): what the server checks, and what it cannot. */
export const DESIGN_DISCLOSURE = "This picture is created in your browser from the approved version. Posthive checks that the design was approved and that the picture has the design's size. It cannot check the picture itself.";

type Opened = SubmissionDetail & { id: string; version: number };

/** One approved design drawn read-only, the same stage the history and the review use, so the picture is what the person sees. */
function Preview({ design, stageRef, onReady }: { design: ApprovedDesign; stageRef: React.RefObject<CanvasStageHandle | null>; onReady: (ready: boolean) => void }) {
  const source = useMemo<DesignSource<Opened>>(
    () => ({
      load: async () => ({ ...(await getSubmission(design.instanceId, design.number)).submission, id: design.instanceId, version: design.number }),
      imageIds: (s) => assetIdsOf(s.document),
    }),
    [design.instanceId, design.number],
  );
  const { engine, design: opened, problem, failure } = useOpenedDesign<Opened>(design.instanceId, source);
  // the picture can be taken only when the engine, the document AND every image are in (a missing one would be a grey box in the PNG)
  const complete = engine !== null && opened !== null && opened.missing.length === 0;
  useEffect(() => onReady(complete), [complete, onReady]);

  if (problem) return <p className="type-body-r-s text-muted">This design can&apos;t be shown.</p>;
  if (failure) {
    return (
      <p className="type-body-r-s text-red-600">
        {failure.message}{" "}
        <button type="button" className="cursor-pointer underline underline-offset-2" onClick={failure.retry}>
          Try again
        </button>
      </p>
    );
  }
  if (!engine || !opened) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Loading the design" className="text-brand-800" />
      </div>
    );
  }
  return (
    <>
      {opened.missing.length > 0 && <p className="mb-2 type-body-r-xs text-red-600">An image of this design could not be loaded, so it can&apos;t be attached. Close this and try again.</p>}
      <ReadOnlyStage engine={engine} doc={opened.document} images={opened.images} stageRef={stageRef} />
    </>
  );
}

/**
 * Pick one of MY approved Canvas designs and attach it as a picture of the post. Every approved version is listed, not only the latest;
 * nothing else is (a draft, a pending review and "changes requested" are not approved). The picture is drawn here at 1x and sent to the
 * server UNCHANGED; it checks the design is an approved one of mine and that the picture has its size.
 */
export function ApprovedDesignPicker({ open, onClose, onAttach }: { open: boolean; onClose: () => void; onAttach: (attached: { submissionId: string; url: string; bytes: number }) => void }) {
  const [items, setItems] = useState<ApprovedDesign[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [more, setMore] = useState(false);
  const [picked, setPicked] = useState<ApprovedDesign | null>(null);
  const [ready, setReady] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const stage = useRef<CanvasStageHandle | null>(null);
  const onReady = useCallback((r: boolean) => setReady(r), []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setState("loading");
    setPicked(null);
    setProblem(null);
    listApprovedDesigns().then(
      (page) => {
        if (!live) return;
        setItems(page.designs);
        setNext(page.nextCursor);
        setState("ready");
      },
      () => live && setState("error"),
    );
    return () => {
      live = false;
    };
  }, [open, attempt]);

  async function loadMore() {
    if (!next || more) return;
    setProblem(null);
    setMore(true);
    try {
      const page = await listApprovedDesigns(next);
      // a version never appears twice, even if a page overlapped
      setItems((cur) => [...cur, ...page.designs.filter((d) => !cur.some((c) => c.submissionId === d.submissionId))]);
      setNext(page.nextCursor);
    } catch (e) {
      setProblem(canvasProblem(e, "More designs could not be loaded. Try again."));
    } finally {
      setMore(false);
    }
  }

  async function attach() {
    const handle = stage.current;
    if (!picked || !handle || attaching) return;
    setAttaching(true);
    setProblem(null);
    try {
      const png = await handle.exportImage({ format: "png", multiplier: 1 });
      const { url, bytes } = await uploadDesignImage(picked.submissionId, png);
      onAttach({ submissionId: picked.submissionId, url, bytes });
      onClose();
    } catch (e) {
      // nothing was attached: the post is unchanged and the person can try again
      setProblem(canvasProblem(e, "The design could not be attached. Try again."));
    } finally {
      setAttaching(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!attaching) onClose(); }} maxWidth={980}>
      <div className="flex max-h-[85vh] flex-col gap-3 p-5" role="dialog" aria-labelledby="approved-heading">
        <h2 id="approved-heading" className="type-body-sb-m text-fg">Use an approved design</h2>
        <p className="type-body-r-xs text-muted">{DESIGN_DISCLOSURE}</p>

        {state === "loading" && (
          <p className="flex items-center gap-2 type-body-r-s text-muted">
            <Spinner label="Loading your approved designs" className="text-brand-800" /> Loading your approved designs
          </p>
        )}
        {state === "error" && (
          <InlineAlert tone="danger" title="Your approved designs didn't load">
            Check your connection and try again.{" "}
            <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
          </InlineAlert>
        )}
        {state === "ready" && items.length === 0 && <EmptyState title="No approved designs yet" description="A design appears here once the design team has approved it. Open it in Canvas and submit it for review." />}

        {state === "ready" && items.length > 0 && (
          <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[18rem_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
              <ul className="flex flex-col gap-1.5" aria-label="Approved designs">
                {items.map((d) => (
                  <li key={d.submissionId}>
                    <button
                      type="button"
                      aria-pressed={picked?.submissionId === d.submissionId}
                      onClick={() => {
                        setPicked(d);
                        setReady(false);
                        setProblem(null);
                      }}
                      className={cn("card w-full cursor-pointer p-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40", picked?.submissionId === d.submissionId && "border-brand-500 bg-brand-100/40")}
                    >
                      <span className="block truncate type-body-sb-s text-fg">{d.name}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 type-body-r-xs text-muted">
                        Version {d.number} · approved {d.approvedAt ? formatWhen(d.approvedAt) : formatWhen(d.submittedAt)}
                        {d.archived && (
                          <Badge variant="default">
                            <ArchiveIcon /> Archived
                          </Badge>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {next && (
                <Button variant="secondary" size="sm" disabled={more} onClick={() => void loadMore()}>
                  {more ? "Loading…" : "Load more"}
                </Button>
              )}
            </div>

            <div className="flex min-h-64 min-w-0 flex-col">
              {picked ? <Preview key={picked.submissionId} design={picked} stageRef={stage} onReady={onReady} /> : <p className="m-auto type-body-r-s text-muted">Pick a version to see it.</p>}
            </div>
          </div>
        )}

        {problem && <InlineAlert tone="danger" role="alert">{problem}</InlineAlert>}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={attaching}>Cancel</Button>
          <Button onClick={() => void attach()} disabled={!picked || !ready || attaching}>{attaching ? "Attaching…" : "Attach this design"}</Button>
        </div>
      </div>
    </Modal>
  );
}
