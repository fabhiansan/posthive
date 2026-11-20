"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { cn } from "../lib/cn";
import type { Category } from "../lib/contentTypes";
import { figmaLinkError } from "../lib/figmaLink";
import { FORMATS, MAX_SLIDES, MIN_SLIDES, PLATFORMS } from "../lib/template-library";
import { platformLabel } from "../lib/platforms";
import { fileHref, hasFigmaSource, type DesignTemplate, type SlideImage, type TemplateFormat, type TemplatePlatform } from "../lib/templates";
import { ContentTypeSelects, type ContentType } from "./ContentTypeSelects";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const IMAGE_TYPES = "image/jpeg,image/png,image/webp,image/gif";

interface UploadedFile {
  url: string;
  /** Uploaded in this editor session and not saved yet — safe to delete from storage. */
  fresh: boolean;
}

/** One slide in the editor: its image, its short name as typed ("" for none) and whether it was uploaded in this session. */
interface SlideRow extends UploadedFile {
  label: string;
}

const MAX_CAPTION = 2000;
const MAX_LABEL = 40;

function discardUpload(url: string) {
  fetch(`${API_BASE}/upload`, { method: "DELETE", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }).catch(() => {});
}

// Design team only: the reference design for one content type (Pillar + Category) —
// a Figma link, plus an optional preview image, format and platforms. A new template is a draft: Marketing sees it
// as a reference in Compose once it is published (on the template's own page); nothing here is ever copied into a post.
export function TemplateEditor({ template, takenCategories, onClose, onSaved }: {
  template: DesignTemplate | null; // null = new template
  /** Categories that already have a template (one per category). */
  takenCategories: Set<Category>;
  onClose: () => void;
  onSaved: (template: DesignTemplate) => void;
}) {
  const [type, setType] = useState<ContentType>({ pillar: template?.pillar ?? null, category: template?.category ?? null });
  const [linkUrl, setLinkUrl] = useState(template?.linkUrl ?? "");
  const [format, setFormat] = useState<TemplateFormat | "">(template?.format ?? "");
  const [slides, setSlides] = useState(template?.slides ? String(template.slides) : "");
  const [platforms, setPlatforms] = useState<TemplatePlatform[]>(template?.platforms ?? []);
  const [preview, setPreview] = useState<UploadedFile | null>(() =>
    template?.previewUrl ? { url: template.previewUrl, fresh: false } : null);
  const [slideRows, setSlideRows] = useState<SlideRow[]>(() =>
    (template?.slideImages ?? []).map((s: SlideImage) => ({ url: s.url, label: s.label ?? "", fresh: false })));
  const [caption, setCaption] = useState(template?.captionGuideline ?? "");
  const [linkTouched, setLinkTouched] = useState(false);
  const [uploadingPreview, setUploadingPreview] = useState(false);
  const [uploadingSlides, setUploadingSlides] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLInputElement>(null);
  const slidesRef = useRef<HTMLInputElement>(null);
  // Fresh uploads at close time, so cancel can remove them from storage
  const freshRef = useRef<string[]>([]);
  freshRef.current = [...(preview?.fresh ? [preview.url] : []), ...slideRows.filter((r) => r.fresh).map((r) => r.url)];

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && !saving) close(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function close() {
    // Drop files uploaded in this session that never made it into a saved template
    freshRef.current.forEach(discardUpload);
    onClose();
  }

  async function uploadPreview(picked: File | undefined) {
    if (previewRef.current) previewRef.current.value = "";
    if (!picked) return;
    setError(null);
    setUploadingPreview(true);
    try {
      const formData = new FormData();
      formData.append("file", picked);
      const res = await apiFetch<{ url: string }>("/upload", { method: "POST", body: formData });
      if (preview?.fresh) discardUpload(preview.url);
      setPreview({ url: res.url, fresh: true });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Upload failed — is the API running?");
    } finally {
      setUploadingPreview(false);
    }
  }

  function removePreview() {
    if (preview?.fresh) discardUpload(preview.url);
    setPreview(null);
  }

  // Several pictures at once, uploaded one after the other so a failure keeps the ones that arrived and says which did not.
  async function uploadSlides(picked: FileList | null) {
    const files = [...(picked ?? [])];
    if (slidesRef.current) slidesRef.current.value = "";
    if (files.length === 0) return;
    setError(null);
    const room = MAX_SLIDES - slideRows.length;
    if (files.length > room) setError(`A carousel has at most ${MAX_SLIDES} slides. ${room > 0 ? `The first ${room} were added.` : "Remove a slide first."}`);
    setUploadingSlides(true);
    try {
      for (const file of files.slice(0, Math.max(0, room))) {
        try {
          const formData = new FormData();
          formData.append("file", file);
          const res = await apiFetch<{ url: string }>("/upload", { method: "POST", body: formData });
          setSlideRows((rows) => [...rows, { url: res.url, label: "", fresh: true }]);
        } catch (e) {
          setError(`${file.name}: ${e instanceof Error && e.message ? e.message : "upload failed"}`);
        }
      }
    } finally {
      setUploadingSlides(false);
    }
  }

  function removeSlide(url: string) {
    const row = slideRows.find((r) => r.url === url);
    if (row?.fresh) discardUpload(url);
    setSlideRows((rows) => rows.filter((r) => r.url !== url));
  }

  function moveSlide(from: number, to: number) {
    setSlideRows((rows) => {
      if (to < 0 || to >= rows.length) return rows;
      const next = [...rows];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  }

  async function save() {
    setError(null);
    const link = linkUrl.trim();
    if (!type.category) return setError("Pick the content pillar and category.");
    setLinkTouched(true);
    if (linkError) return; // a blank link is allowed: a template designed in Canvas has none
    const images = format === "carousel" ? slideRows : [];
    if (images.length === 1) return setError(`A carousel has ${MIN_SLIDES} to ${MAX_SLIDES} slides. Add another slide image, or remove this one.`);
    // with pictures the count is the number of pictures (the API does the same); without, the typed number
    const slideCount = images.length > 0 ? images.length : format === "carousel" && slides.trim() !== "" ? Number(slides) : null;
    if (slideCount !== null && (!Number.isInteger(slideCount) || slideCount < MIN_SLIDES || slideCount > MAX_SLIDES)) {
      return setError(`A carousel has ${MIN_SLIDES} to ${MAX_SLIDES} slides.`);
    }
    setSaving(true);
    try {
      const body = {
        pillar: type.pillar,
        category: type.category,
        linkUrl: link || null,
        previewUrl: preview?.url ?? null,
        format: format || null,
        slides: slideCount,
        platforms,
        slideImages: images.map((r) => ({ url: r.url, label: r.label.trim() || null })),
        captionGuideline: caption.trim() || null,
      };
      const res = await apiFetch<{ template: DesignTemplate }>(template ? `/templates/${template.id}` : "/templates", {
        method: template ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      // pictures uploaded for a carousel that is no longer one were not saved: take them out of storage
      if (format !== "carousel") slideRows.filter((r) => r.fresh).forEach((r) => discardUpload(r.url));
      freshRef.current = [];
      onSaved(res.template);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't save the template. Check the fields and try again.");
    } finally {
      setSaving(false);
    }
  }

  const busy = uploadingPreview || uploadingSlides;
  const linkError = linkUrl.trim() ? figmaLinkError(linkUrl) : null;
  const showLinkError = linkTouched && !!linkError;
  const otherTaken = new Set([...takenCategories].filter((c) => c !== template?.category));
  const togglePlatform = (p: TemplatePlatform) => setPlatforms((on) => (on.includes(p) ? on.filter((x) => x !== p) : [...on, p]));

  return (
    <div className="fixed inset-0 z-1000 flex items-center justify-center bg-black/75 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) close(); }}>
      <style>{`.template-editor :focus-visible { outline: 2px solid var(--color-brand-800); outline-offset: 2px; }`}</style>
      <div role="dialog" aria-modal="true" aria-label={template ? "Edit template" : "Upload template"}
        className="template-editor card w-full max-w-160 max-h-[92vh] flex flex-col overflow-hidden">

        <div className="flex items-start gap-3 px-6 pt-5 pb-4 shrink-0 border-b border-border">
          <div className="flex-1">
            <h2 className="type-body-sb-m text-fg">{template ? "Edit template" : "Upload template"}</h2>
            <p className="type-body-r-xs mt-1 text-muted">
              {template
                ? "The design for one content type. Marketing opens it as a reference when making a post; it is never attached to posts."
                : "The design for one content type. It starts as a draft: Marketing sees it once you publish it from its page."}
            </p>
          </div>
          <button type="button" onClick={close} disabled={saving} aria-label="Close"
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border border-border text-muted">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <section>
            <ContentTypeSelects idPrefix="template" pillar={type.pillar} category={type.category}
              onChange={setType} takenCategories={otherTaken} />
            <p className="type-body-r-xs mt-1.5 text-muted">One template per category.</p>
          </section>

          <div>
            <label htmlFor="template-link" className="type-body-sb-s text-fg">Figma link</label>
            <p id="template-link-hint" className="type-body-r-xs mt-0.5 text-muted">
              Link to the design in Figma, like figma.com/design/…. It opens in a new tab. Optional when the template is designed in Canvas: a template needs a Figma link or a published Canvas revision before it can be published.
            </p>
            <input id="template-link" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value.slice(0, 2048))}
              onBlur={() => setLinkTouched(true)} type="url" inputMode="url" autoComplete="off"
              placeholder="https://www.figma.com/design/…" aria-invalid={showLinkError}
              aria-describedby={showLinkError ? "template-link-error" : "template-link-hint"}
              className={cn("field mt-1.5", showLinkError && "border-red-200 bg-red-50")} />
            {showLinkError && <p id="template-link-error" className="type-body-r-xs mt-1.5 text-red-600">{linkError}</p>}
            {/* The API allows this (the Canvas revision is still a source) but the public API and MCP list a template with a Canvas design only through its Figma link. */}
            {template?.published && template.designId && hasFigmaSource(template.linkUrl) && !linkUrl.trim() && (
              <p role="status" className="type-body-r-xs mt-1.5 text-brand-800">
                Without a Figma link this template is no longer returned by the public API and MCP. Marketing still sees it in the library.
              </p>
            )}
          </div>

          <section className="grid gap-3 sm:grid-cols-2">
            <label className="block" htmlFor="template-format">
              <span className="type-body-sb-xs text-muted">Content format <span className="type-body-r-xs">Optional</span></span>
              <select id="template-format" value={format} onChange={(e) => setFormat(e.target.value as TemplateFormat | "")} className="field mt-1.5">
                <option value="">No format yet</option>
                {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
            {format === "carousel" && slideRows.length === 0 && (
              <label className="block" htmlFor="template-slides">
                <span className="type-body-sb-xs text-muted">Slides <span className="type-body-r-xs">{MIN_SLIDES} to {MAX_SLIDES}</span></span>
                <input id="template-slides" type="number" inputMode="numeric" min={MIN_SLIDES} max={MAX_SLIDES} value={slides}
                  onChange={(e) => setSlides(e.target.value)} className="field mt-1.5" />
              </label>
            )}
          </section>

          <section>
            <h3 className="type-body-sb-s text-fg">
              Publishing platforms <span className="type-body-r-xs text-muted">Optional</span>
            </h3>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Publishing platforms">
              {PLATFORMS.map((p) => (
                <button key={p} type="button" aria-pressed={platforms.includes(p)} onClick={() => togglePlatform(p)}
                  className={cn("chip px-3 py-1.5 type-body-m-s", platforms.includes(p) && "chip-active")}>
                  {platformLabel(p)}
                </button>
              ))}
            </div>
          </section>

          {format === "carousel" && (
            <section aria-labelledby="template-slides-heading">
              <h3 id="template-slides-heading" className="type-body-sb-s text-fg">
                Slide images <span className="type-body-r-xs text-muted">{MIN_SLIDES} to {MAX_SLIDES}, optional</span>
              </h3>
              <p className="type-body-r-xs mt-0.5 text-muted">
                One picture per slide, in order. Marketing pages through them in the preview and sees each name under its slide. The number of slides is the number of pictures.
              </p>
              {slideRows.length > 0 && (
                <ol className="mt-2 flex flex-col gap-2">
                  {slideRows.map((row, i) => (
                    <li key={row.url} className="flex items-center gap-3 rounded-lg border border-border p-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={fileHref(row.url)} alt={`Slide ${i + 1}`} className="h-14 w-11 shrink-0 rounded-md border border-border object-cover" />
                      <span className="w-5 shrink-0 text-center type-body-sb-xs text-muted" aria-hidden="true">{i + 1}</span>
                      <input
                        aria-label={`Name of slide ${i + 1}`}
                        value={row.label}
                        maxLength={MAX_LABEL}
                        placeholder={`Slide ${i + 1}`}
                        onChange={(e) => setSlideRows((rows) => rows.map((r) => (r.url === row.url ? { ...r, label: e.target.value } : r)))}
                        className="field min-w-0 flex-1"
                      />
                      <button type="button" aria-label={`Move slide ${i + 1} up`} disabled={i === 0 || busy} onClick={() => moveSlide(i, i - 1)}
                        className="w-8 h-8 rounded-lg border border-border text-muted disabled:opacity-40">↑</button>
                      <button type="button" aria-label={`Move slide ${i + 1} down`} disabled={i === slideRows.length - 1 || busy} onClick={() => moveSlide(i, i + 1)}
                        className="w-8 h-8 rounded-lg border border-border text-muted disabled:opacity-40">↓</button>
                      <button type="button" aria-label={`Remove slide ${i + 1}`} disabled={busy} onClick={() => removeSlide(row.url)}
                        className="px-2.5 py-1 rounded-lg border border-border type-body-r-xs text-muted hover:text-red-600 disabled:opacity-50">Remove</button>
                    </li>
                  ))}
                </ol>
              )}
              <button type="button" onClick={() => slidesRef.current?.click()} disabled={busy || slideRows.length >= MAX_SLIDES}
                className="mt-2 px-3 py-2 dropzone bg-bg type-body-r-s text-fg hover:border-neutral-300 disabled:opacity-60">
                {uploadingSlides ? "Uploading…" : slideRows.length > 0 ? "Add slide images" : "Upload slide images"}
              </button>
              <input ref={slidesRef} type="file" multiple accept={IMAGE_TYPES} hidden onChange={(e) => uploadSlides(e.target.files)} />
            </section>
          )}

          <section>
            <label htmlFor="template-caption" className="type-body-sb-s text-fg">
              Caption guideline <span className="type-body-r-xs text-muted">Optional</span>
            </label>
            <p id="template-caption-hint" className="type-body-r-xs mt-0.5 text-muted">
              How a caption for this kind of post should read. Marketing sees it next to the design and writes its own caption; it is never copied into a post.
            </p>
            <textarea id="template-caption" value={caption} maxLength={MAX_CAPTION} rows={4} onChange={(e) => setCaption(e.target.value)}
              aria-describedby="template-caption-hint template-caption-count" className="field mt-1.5 resize-y" />
            <p id="template-caption-count" className="type-body-r-xs mt-1 text-right text-muted">{caption.length} / {MAX_CAPTION}</p>
          </section>

          <section>
            <h3 className="type-body-sb-s text-fg">
              Preview image <span className="type-body-r-xs text-muted">Optional</span>
            </h3>
            <p className="type-body-r-xs mt-0.5 text-muted">
              Shown in the library and in Compose so Marketing recognises the layout. Never attached to posts.
            </p>
            {preview ? (
              <div className="flex items-end gap-3 mt-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fileHref(preview.url)} alt="Template preview" className="w-24 h-30 rounded-lg border border-border object-cover" />
                <button type="button" onClick={() => previewRef.current?.click()} disabled={busy}
                  className="btn-secondary px-2.5 py-1 rounded-lg type-body-r-xs">
                  {uploadingPreview ? "Uploading…" : "Replace"}
                </button>
                <button type="button" onClick={removePreview} disabled={busy}
                  className="px-2.5 py-1 rounded-lg border border-border type-body-r-xs text-muted hover:text-red-600 disabled:opacity-50">Remove</button>
              </div>
            ) : (
              <button type="button" onClick={() => previewRef.current?.click()} disabled={busy}
                className="mt-2 px-3 py-2 dropzone bg-bg type-body-r-s text-fg hover:border-neutral-300 disabled:opacity-60">
                {uploadingPreview ? "Uploading…" : "Upload preview"}
              </button>
            )}
            <input ref={previewRef} type="file" accept={IMAGE_TYPES} hidden onChange={(e) => uploadPreview(e.target.files?.[0])} />
          </section>
        </div>

        <div className="flex items-center gap-3 px-6 py-4 shrink-0 border-t border-border">
          <p role="alert" className="flex-1 type-body-r-xs text-red-600">{error}</p>
          <button type="button" onClick={close} disabled={saving} className="btn-secondary">Cancel</button>
          <button type="button" onClick={save} disabled={saving || busy} className="btn-primary">
            {saving ? "Saving…" : template ? "Save changes" : "Save as draft"}
          </button>
        </div>
      </div>
    </div>
  );
}
