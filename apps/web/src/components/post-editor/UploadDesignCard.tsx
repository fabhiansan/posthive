"use client";

import { useRef, useState, type DragEvent } from "react";
import { CloudUploadIcon, FileVideoIcon, LinkIcon, XIcon } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiFetch, assetUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { IMAGE_TYPES, MAX_FILES, MAX_IMAGE_MB, designLinkProblem, imageProblem, isVideoUrl, type PostFormat } from "@/lib/post-editor";

type Props = {
  format: PostFormat | "";
  mediaUrls: string[];
  designFigmaUrl: string;
  onMedia: (urls: string[]) => void;
  onFigma: (url: string) => void;
  onBusy: (busy: boolean) => void;
  disabled?: boolean;
};

/** Card C: the finished design as PNG or JPG (one file per slide of a carousel), and optionally the Figma link to its source. */
export function UploadDesignCard({ format, mediaUrls, designFigmaUrl, onMedia, onFigma, onBusy, disabled }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [working, setWorking] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
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
    if (added.length > 0) onMedia(single ? [...mediaUrls.filter(isVideoUrl), ...added] : [...mediaUrls, ...added]);
    setWorking(false);
    onBusy(false);
    if (input.current) input.current.value = "";
  }

  const remove = (url: string) => onMedia(mediaUrls.filter((u) => u !== url));
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
        <Button variant="secondary" size="sm" disabled={disabled || working} onClick={() => input.current?.click()}>Browse files</Button>
        <input ref={input} type="file" accept={IMAGE_TYPES.join(",")} multiple={!single} hidden aria-label="Choose design files" onChange={(e) => void upload(Array.from(e.target.files ?? []))} />
      </div>

      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 type-body-r-xs text-red-600">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
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
