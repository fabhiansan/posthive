"use client";

import { useRef, useState, type DragEvent } from "react";
import { CloudUploadIcon, FileTextIcon, FileVideoIcon, LinkIcon, XIcon } from "lucide-react";
import { InlineAlert } from "@/components/InlineAlert";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiFetch, assetUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { DesignExport } from "@/lib/designExport";
import { designImageProblems, pruneDesigns, type PostDesign } from "@/lib/designImage";
import { IMAGE_TYPES, MAX_FILES, MAX_IMAGE_MB, designLinkProblem, imageProblem, isVideoUrl, type PostFormat } from "@/lib/post-editor";
import { DESIGN_DISCLOSURE } from "./ApprovedDesignPicker";

type Props = {
  format: PostFormat | "";
  mediaUrls: string[];
  /** The approved Canvas designs among the pictures; the pictures and the designs always change together. */
  canvasDesigns: PostDesign[];
  /** The channels of the post, for the warning about a design a channel cannot take. */
  platforms: readonly string[];
  designFigmaUrl: string;
  /** The files the Studio saved for this draft, shown apart from the manual uploads. */
  designExport: DesignExport | null;
  onMedia: (change: { mediaUrls: string[]; canvasDesigns: PostDesign[] }) => void;
  onFigma: (url: string) => void;
  onRemoveExport: () => Promise<void>;
  onBusy: (busy: boolean) => void;
  disabled?: boolean;
};

/**
 * Card C: the finished design as PNG or JPG (one file per slide of a carousel), the files the Studio saved for this draft, and
 * optionally the Figma link to its source. Posts from before Path A may also carry approved Canvas designs among the pictures;
 * those are still marked and warned about, but the picker is no longer offered here.
 */
export function UploadDesignCard({ format, mediaUrls, canvasDesigns, platforms, designFigmaUrl, designExport, onMedia, onFigma, onRemoveExport, onBusy, disabled }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [working, setWorking] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [removing, setRemoving] = useState(false);
  const designUrls = new Set(canvasDesigns.map((d) => d.mediaUrl));
  const designProblems = designImageProblems(canvasDesigns, platforms);
  const single = format === "single";
  const images = mediaUrls.filter((u) => !isVideoUrl(u));
  const link = touched ? designLinkProblem(designFigmaUrl) : null;

  async function upload(files: File[]) {
    if (files.length === 0) return;
    const found: string[] = [];
    // a single image takes the one file; a carousel takes as many as it has slides
    const wanted = single ? files.slice(0, 1) : files;
    if (single && files.length > 1) found.push("A single image takes one file. The first one is used.");
    // a post takes at most MAX_FILES pictures, the ones already there included
    const room = Math.max(0, MAX_FILES - images.length);
    if (!single && wanted.length > room) found.push(`A post takes ${MAX_FILES} files at most. ${room === 0 ? "Remove one first." : `Only the first ${room} are used.`}`);
    const ok = (single ? wanted : wanted.slice(0, room)).filter((f) => {
      const problem = imageProblem(f);
      if (problem) found.push(problem);
      return !problem;
    });
    setProblems(found);
    if (ok.length === 0) return;

    setWorking(true);
    onBusy(true);
    const added: string[] = [];
    // one after the other: the order the person chose is the order of the slides
    for (const file of ok) {
      try {
        const body = new FormData();
        body.append("file", file);
        const { url } = await apiFetch<{ url: string }>("/upload", { method: "POST", body });
        added.push(url);
      } catch (e) {
        found.push(`${file.name}: ${e instanceof Error && e.message ? e.message : "the upload failed."}`);
      }
    }
    setProblems([...found]);
    if (added.length > 0) change(single ? [...mediaUrls.filter(isVideoUrl), ...added] : [...mediaUrls, ...added]);
    setWorking(false);
    onBusy(false);
    if (input.current) input.current.value = "";
  }

  /** The pictures and the designs change in ONE patch, so a design never outlives its picture (the server prunes the same way). */
  const change = (urls: string[], designs: PostDesign[] = canvasDesigns) => onMedia({ mediaUrls: urls, canvasDesigns: pruneDesigns(designs, urls) });
  const remove = (url: string) => change(mediaUrls.filter((u) => u !== url));
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) void upload(Array.from(e.dataTransfer.files));
  };

  return (
    <Card className="gap-4 border-0 p-5" role="region" aria-labelledby="upload-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="upload-heading" className="type-body-sb-m text-fg">C · Upload design</h2>
        <p className="min-w-0 truncate text-right type-body-r-xs text-muted">PNG or JPG · works with or without a template</p>
      </div>

      <div
        className={cn("dropzone flex flex-col items-center gap-2 px-4 py-8 text-center", over && "border-brand-500 bg-brand-100/40")}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        {working ? <Spinner label="Uploading" /> : <CloudUploadIcon aria-hidden="true" className="size-7 text-neutral-500" />}
        <p className="type-body-sb-s text-fg">{working ? "Uploading…" : "Drag & drop your finished design here"}</p>
        <p className="type-body-r-xs text-muted">
          PNG or JPG · up to {MAX_IMAGE_MB} MB · {single ? "one file" : "carousel = one file per slide"}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="secondary" size="sm" disabled={disabled || working} onClick={() => input.current?.click()}>Browse files</Button>
        </div>
        <input ref={input} type="file" accept={IMAGE_TYPES.join(",")} multiple={!single} hidden aria-label="Choose design files" onChange={(e) => void upload(Array.from(e.target.files ?? []))} />
      </div>

      {designExport && designExport.files.length > 0 && (
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
            <p className="type-body-sb-xs text-fg">From the Studio</p>
            <p className="type-body-r-xxs text-muted">Saved automatically from this draft&apos;s design</p>
          </div>
          <ol aria-label="Generated design files" className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {designExport.files.map((file) => (
              <li key={file.mediaUrl} className="group relative aspect-square overflow-hidden rounded-xl bg-neutral-50">
                {file.format === "pdf" ? (
                  <a href={assetUrl(file.mediaUrl)} target="_blank" rel="noopener noreferrer" className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center text-muted hover:text-fg">
                    <FileTextIcon aria-hidden="true" className="size-6" />
                    <span className="type-body-sb-xxs">PDF</span>
                    <span className="type-body-r-xxs">Open</span>
                  </a>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={assetUrl(file.mediaUrl)} alt={`Generated ${file.format.toUpperCase()}`} loading="lazy" className="size-full object-cover" />
                )}
                <span className="absolute right-1 bottom-1 rounded-md bg-neutral-900/70 px-1.5 type-body-sb-xxs text-white">Studio</span>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label="Remove the generated design"
                  disabled={disabled || removing}
                  onClick={async () => {
                    if (removing) return;
                    setRemoving(true);
                    try {
                      await onRemoveExport();
                    } finally {
                      setRemoving(false);
                    }
                  }}
                  className="absolute top-1 right-1 size-6"
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 type-body-r-xs text-red-600">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}

      {canvasDesigns.length > 0 && (
        <p className="type-body-r-xs text-muted">{DESIGN_DISCLOSURE}</p>
      )}
      {designProblems.length > 0 && (
        <InlineAlert tone="warning" title="An approved design can't go to every channel you picked">
          <ul className="list-disc space-y-1 pl-4">
            {designProblems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </InlineAlert>
      )}

      {mediaUrls.length > 0 && (
        <ol aria-label="Uploaded files" className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {mediaUrls.map((url) => {
            const video = isVideoUrl(url);
            const n = images.indexOf(url) + 1;
            return (
              <li key={url} className="group relative aspect-square overflow-hidden rounded-xl bg-neutral-50">
                {video ? (
                  <div className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center text-muted">
                    <FileVideoIcon aria-hidden="true" className="size-5" />
                    <span className="type-body-r-xxs">Video from the old editor</span>
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={assetUrl(url)} alt={`File ${n}`} loading="lazy" className="size-full object-cover" />
                )}
                {!video && !single && <span className="absolute bottom-1 left-1 rounded-md bg-neutral-900/70 px-1.5 type-body-sb-xxs text-white">{n}</span>}
                {designUrls.has(url) && <span className="absolute right-1 bottom-1 rounded-md bg-neutral-900/70 px-1.5 type-body-sb-xxs text-white">Canvas</span>}
                <Button variant="secondary" size="icon-sm" aria-label={video ? "Remove the video" : `Remove file ${n}`} disabled={disabled} onClick={() => remove(url)} className="absolute top-1 right-1 size-6">
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ol>
      )}

      <div>
        <label className="block">
          <span className="type-body-sb-xs text-muted">Figma link to your customised design (optional)</span>
          <span className="relative mt-1.5 block">
            <LinkIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-neutral-500" />
            <Input type="url" value={designFigmaUrl} disabled={disabled} onChange={(e) => onFigma(e.target.value)} onBlur={() => setTouched(true)} placeholder="Paste a Figma frame link" className="pl-9" aria-invalid={link ? true : undefined} />
          </span>
        </label>
        {link ? <p role="alert" className="mt-1.5 type-body-r-xs text-red-600">{link}</p> : <p className="mt-1.5 type-body-r-xs text-muted">Kept on the post so reviewers can open the source file.</p>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-red-50/60 px-4 py-3">
          <p className="type-body-sb-xs text-fg">Workflow 1 · Using a template</p>
          <p className="type-body-r-xs text-muted">Choose template → Open in Studio → Customise → Upload here</p>
        </div>
        <div className="rounded-xl bg-red-50/60 px-4 py-3">
          <p className="type-body-sb-xs text-fg">Workflow 2 · Using an existing design</p>
          <p className="type-body-r-xs text-muted">Skip the template and upload a finished PNG/JPG directly</p>
        </div>
      </div>
    </Card>
  );
}
