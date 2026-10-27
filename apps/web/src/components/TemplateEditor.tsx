"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { CATEGORY_INFO, PILLARS, defaultSlideLabels, type Category } from "../lib/contentTypes";
import type { RawTemplate, TemplateKit } from "../lib/templates";
import { toMediaItems } from "./MediaStage";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const MAX_SLIDES = 20; // matches the /templates body schema
const IMAGE_TYPES = "image/jpeg,image/png,image/webp,image/gif";

interface SlideDraft {
  url: string;
  previewUrl: string;
  guide: string;
  /** Uploaded in this editor session and not saved yet — safe to delete from storage. */
  fresh: boolean;
}

const CATEGORY_GROUPS: { label: string; categories: Category[] }[] = [
  ...PILLARS.map((p) => ({
    label: p,
    categories: (Object.keys(CATEGORY_INFO) as Category[]).filter((c) => CATEGORY_INFO[c].pillar === p),
  })),
  { label: "Outside the pillars", categories: (Object.keys(CATEGORY_INFO) as Category[]).filter((c) => CATEGORY_INFO[c].pillar === null) },
];

const inputStyle = { background: "#0a0a0a", border: "1px solid #2a2a2a", borderRadius: 10, padding: "9px 12px", fontSize: 14, color: "#ededed" } as const;

function discardUpload(url: string) {
  fetch(`${API_BASE}/upload`, { method: "DELETE", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }).catch(() => {});
}

// Design team only: upload the designs for one content type, describe the copy each
// slide needs, and draft the caption. Marketing fills in the copy from Compose.
export function TemplateEditor({ template, onClose, onSaved }: {
  template: TemplateKit | null; // null = new template
  onClose: () => void;
  onSaved: (raw: RawTemplate) => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [category, setCategory] = useState<Category | "">(template?.category ?? "");
  const [format, setFormat] = useState<"carousel" | "poster">(template?.format ?? "carousel");
  const [slides, setSlides] = useState<SlideDraft[]>(() =>
    toMediaItems(template?.mediaUrls ?? []).map((m, i) => ({ url: m.url, previewUrl: m.previewUrl, guide: template?.slides[i]?.guide ?? "", fresh: false })));
  const [text, setText] = useState(template?.text ?? "");
  const [commentText, setCommentText] = useState(template?.commentText ?? "");
  const [uploading, setUploading] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const slidesRef = useRef(slides);
  slidesRef.current = slides;

  const labels = defaultSlideLabels(slides.length);
  const maxSlides = format === "poster" ? 1 : MAX_SLIDES;
  const suggested = category ? CATEGORY_INFO[category].slides : null;

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && !saving) close(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function close() {
    // Drop designs uploaded in this session that never made it into a saved template
    slidesRef.current.filter((s) => s.fresh).forEach((s) => discardUpload(s.url));
    onClose();
  }

  function pickCategory(c: Category | "") {
    setCategory(c);
    // Single-slide categories are posters by default (docs/content-types.md slide table)
    if (c && slides.length === 0) setFormat(CATEGORY_INFO[c].slides === 1 ? "poster" : "carousel");
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    const room = maxSlides - slides.length;
    const picked = Array.from(files).slice(0, Math.max(room, format === "poster" ? 1 : 0));
    if (picked.length < files.length) setError(format === "poster" ? "A poster has one design." : `Up to ${MAX_SLIDES} slides per template.`);
    setUploading((n) => n + picked.length);
    await Promise.all(picked.map(async (file) => {
      const formData = new FormData();
      formData.append("file", file);
      try {
        const res = await fetch(`${API_BASE}/upload`, { method: "POST", body: formData, credentials: "include" });
        if (!res.ok) { setError(((await res.json()) as { error?: string }).error ?? "Upload failed."); return; }
        const { url } = (await res.json()) as { url: string };
        const [item] = toMediaItems([url]);
        setSlides((prev) => {
          if (format === "poster" && prev.length > 0) {
            // Poster: a new upload replaces the single design
            if (prev[0].fresh) discardUpload(prev[0].url);
            return [{ ...prev[0], url, previewUrl: item.previewUrl, fresh: true }];
          }
          return [...prev, { url, previewUrl: item.previewUrl, guide: "", fresh: true }];
        });
      } catch {
        setError("Upload failed — is the API running?");
      } finally {
        setUploading((n) => n - 1);
      }
    }));
    if (fileRef.current) fileRef.current.value = "";
  }

  function move(i: number, dir: -1 | 1) {
    setSlides((prev) => {
      const next = [...prev];
      [next[i], next[i + dir]] = [next[i + dir], next[i]];
      return next;
    });
  }

  function remove(i: number) {
    const slide = slides[i];
    // Saved designs may already be used by posts — only fresh uploads leave storage
    if (slide.fresh) discardUpload(slide.url);
    setSlides((prev) => prev.filter((_, j) => j !== i));
  }

  async function save() {
    setError(null);
    if (!name.trim()) return setError("Give the template a name.");
    if (!category) return setError("Pick the content category.");
    if (slides.length === 0) return setError("Upload at least one design.");
    if (format === "poster" && slides.length !== 1) return setError("A poster has exactly one design. Remove the extra slides or switch to carousel.");
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        content: {
          text,
          commentText: commentText.trim() || undefined,
          mediaUrls: slides.map((s) => s.url),
          category,
          format,
          slides: slides.map((s, i) => ({ label: labels[i], guide: s.guide.trim() })),
        },
      };
      const res = await apiFetch<{ template: RawTemplate }>(template ? `/templates/${template.id}` : "/templates", {
        method: template ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      setSlides((prev) => prev.map((s) => ({ ...s, fresh: false })));
      slidesRef.current = slidesRef.current.map((s) => ({ ...s, fresh: false }));
      onSaved(res.template);
    } catch (e) {
      // Zod validation errors arrive as an object — show a readable fallback
      const msg = e instanceof Error ? e.message : "";
      setError(msg && msg !== "[object Object]" ? msg : "Couldn't save the template. Check the fields and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.75)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) close(); }}>
      <style>{`.template-editor :focus-visible { outline: 2px solid #5b63d3; outline-offset: 2px; }`}</style>
      <div role="dialog" aria-modal="true" aria-label={template ? "Edit template" : "New template"}
        className="template-editor w-full flex flex-col overflow-hidden"
        style={{ maxWidth: 760, maxHeight: "92vh", background: "#111111", border: "1px solid #2a2a2a", borderRadius: 16 }}>

        <div className="flex items-start gap-3 px-6 pt-5 pb-4 flex-shrink-0" style={{ borderBottom: "1px solid #2a2a2a" }}>
          <div className="flex-1">
            <h2 className="text-base font-bold" style={{ color: "#ededed" }}>{template ? "Edit template" : "New template"}</h2>
            <p className="text-xs mt-1" style={{ color: "#888" }}>
              Upload the designs in order and describe the copy each slide needs. Marketing types the copy in Compose.
            </p>
          </div>
          <button type="button" onClick={close} disabled={saving} aria-label="Close"
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ color: "#888", border: "1px solid #2a2a2a" }}>✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="text-xs font-semibold" style={{ color: "#888" }}>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value.slice(0, 100))} autoFocus
                placeholder="e.g. Product Features, 5-slide carousel" className="w-full mt-1.5" style={inputStyle} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold" style={{ color: "#888" }}>Content category</span>
              <select value={category} onChange={(e) => pickCategory(e.target.value as Category | "")}
                className="w-full mt-1.5" style={inputStyle}>
                <option value="">Choose a category</option>
                {CATEGORY_GROUPS.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </optgroup>
                ))}
              </select>
              {category && (
                <span className="block text-xs mt-1.5" style={{ color: "#888" }}>
                  {CATEGORY_INFO[category].pillar ? `${CATEGORY_INFO[category].pillar} pillar` : "Not part of a pillar"}
                  {suggested && `. Usually ${suggested === 1 ? "a single design" : `${suggested} slides`}.`}
                </span>
              )}
            </label>
            <div>
              <span className="text-xs font-semibold" style={{ color: "#888" }}>Format</span>
              <div role="radiogroup" aria-label="Format" className="flex gap-1 mt-1.5 p-1 rounded-xl" style={{ border: "1px solid #2a2a2a" }}>
                {(["carousel", "poster"] as const).map((f) => (
                  <button key={f} type="button" role="radio" aria-checked={format === f} onClick={() => setFormat(f)}
                    className="flex-1 py-1.5 rounded-lg text-sm font-semibold"
                    style={{ background: format === f ? "#1f1f1f" : "transparent", color: format === f ? "#ededed" : "#888" }}>
                    {f === "carousel" ? "Carousel" : "Poster"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <section>
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <h3 className="text-sm font-semibold" style={{ color: "#ededed" }}>Designs</h3>
              <span className="text-xs" style={{ color: "#888" }}>
                {format === "poster" ? "One design" : `${slides.length} of ${MAX_SLIDES}`}
              </span>
            </div>
            <ol className="space-y-2">
              {slides.map((s, i) => (
                <li key={s.url} className="flex gap-3 p-2.5 rounded-xl" style={{ border: "1px solid #2a2a2a", background: "#0a0a0a" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.previewUrl} alt={labels[i]} className="flex-shrink-0 rounded-lg object-cover"
                    style={{ width: 72, height: 90, border: "1px solid #1f1f1f" }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold" style={{ color: "#ededed" }}>{labels[i]}</span>
                      <div className="ml-auto flex gap-1">
                        {format === "carousel" && (
                          <>
                            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${labels[i]} up`}
                              className="w-7 h-7 rounded-lg text-xs disabled:opacity-30" style={{ border: "1px solid #2a2a2a", color: "#888" }}>↑</button>
                            <button type="button" onClick={() => move(i, 1)} disabled={i === slides.length - 1} aria-label={`Move ${labels[i]} down`}
                              className="w-7 h-7 rounded-lg text-xs disabled:opacity-30" style={{ border: "1px solid #2a2a2a", color: "#888" }}>↓</button>
                          </>
                        )}
                        <button type="button" onClick={() => remove(i)} aria-label={`Remove ${labels[i]}`}
                          className="w-7 h-7 rounded-lg text-xs hover:text-red-400" style={{ border: "1px solid #2a2a2a", color: "#888" }}>✕</button>
                      </div>
                    </div>
                    <textarea value={s.guide} rows={2} aria-label={`Copy guide for ${labels[i]}`}
                      onChange={(e) => { const guide = e.target.value.slice(0, 500); setSlides((prev) => prev.map((x, j) => (j === i ? { ...x, guide } : x))); }}
                      placeholder={i === 0 ? "What goes on this slide, e.g. Title and 4 key points" : "What goes on this slide, e.g. One point with a short explanation"}
                      className="w-full mt-1.5" style={{ ...inputStyle, fontSize: 13, resize: "vertical" }} />
                  </div>
                </li>
              ))}
            </ol>
            {(slides.length < maxSlides || format === "poster") && (
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading > 0}
                className="w-full mt-2 py-3 rounded-xl text-sm font-medium disabled:opacity-60"
                style={{ border: "1px dashed #2a2a2a", color: "#ededed" }}>
                {uploading > 0 ? `Uploading ${uploading}…` : slides.length === 0 ? "Upload designs" : format === "poster" ? "Replace design" : "Add more slides"}
              </button>
            )}
            <input ref={fileRef} type="file" accept={IMAGE_TYPES} multiple={format === "carousel"} hidden
              onChange={(e) => upload(e.target.files)} />
          </section>

          <section className="space-y-4">
            <label className="block">
              <span className="text-sm font-semibold" style={{ color: "#ededed" }}>Caption draft</span>
              <span className="block text-xs mt-0.5" style={{ color: "#888" }}>
                The starting caption Marketing edits. End with a question to the audience, then hashtags.
              </span>
              <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 5000))} rows={4}
                placeholder={"Short intro…\n\nWhat do you think? Share in the comments.\n\n#GIS #Geospatial"}
                className="w-full mt-1.5" style={{ ...inputStyle, resize: "vertical" }} />
            </label>
            <label className="block">
              <span className="text-sm font-semibold" style={{ color: "#ededed" }}>First comment</span>
              <span className="text-xs ml-1.5" style={{ color: "#888" }}>Optional</span>
              <textarea value={commentText} onChange={(e) => setCommentText(e.target.value.slice(0, 2000))} rows={2}
                className="w-full mt-1.5" style={{ ...inputStyle, resize: "vertical" }} />
            </label>
          </section>
        </div>

        <div className="flex items-center gap-3 px-6 py-4 flex-shrink-0" style={{ borderTop: "1px solid #2a2a2a" }}>
          <p role="alert" className="flex-1 text-xs" style={{ color: "#f87171" }}>{error}</p>
          <button type="button" onClick={close} disabled={saving}
            className="px-4 py-2 rounded-xl text-sm" style={{ border: "1px solid #2a2a2a", color: "#888" }}>Cancel</button>
          <button type="button" onClick={save} disabled={saving || uploading > 0}
            className="px-4 py-2 rounded-xl text-sm font-semibold transition-colors hover:bg-gray-100 disabled:opacity-60"
            style={{ backgroundColor: "#ffffff", color: "#0a0a0a" }}>
            {saving ? "Saving…" : template ? "Save changes" : "Save template"}
          </button>
        </div>
      </div>
    </div>
  );
}
