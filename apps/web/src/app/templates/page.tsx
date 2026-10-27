"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { useAuth } from "../../context/AuthContext";
import { useWorkspace } from "../../context/WorkspaceContext";
import { canEditContent, canManageTemplates } from "../../lib/permissions";
import { PILLARS, type Pillar } from "../../lib/contentTypes";
import { formatSummary, parseTemplate, type RawTemplate, type TemplateKit } from "../../lib/templates";
import { MediaStage, toMediaItems } from "../../components/MediaStage";
import { TemplateEditor } from "../../components/TemplateEditor";

const BG = "#0a0a0a";
const BORDER = "#2a2a2a";
const TEXT = "#ededed";
const MUTED = "#888888";

type Group = Pillar | "Other";

// One-line pillar definitions from docs/content-types.md
const GROUP_SUMMARY: Record<Group, string> = {
  Promotional: "Products, services and client results that turn prospects into qualified leads.",
  Educational: "Geospatial insight, articles and how-tos that position Braga as a thought leader.",
  Entertainment: "Lighter, human moments such as CSR and behind the scenes, kept professional.",
  Conversational: "Polls, trend responses, events and commemorations that invite a reply.",
  Other: "Ask Me Anything and caption-only templates without a category.",
};

const GROUPS: Group[] = [...PILLARS, "Other"];

function groupOf(t: TemplateKit): Group {
  return (t.pillar as Pillar | null) ?? "Other";
}

export default function TemplatesPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { activeWorkspace } = useWorkspace();
  const role = activeWorkspace?.role ?? user?.role;
  const canManage = canManageTemplates(role);
  const canUse = canEditContent(role);
  const { success: toastSuccess, error: toastError } = useToast();

  const [templates, setTemplates] = useState<TemplateKit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pillar, setPillar] = useState<Group | "all">("all");
  const [format, setFormat] = useState<"all" | "carousel" | "poster">("all");
  const [viewing, setViewing] = useState<TemplateKit | null>(null);
  const [editing, setEditing] = useState<TemplateKit | "new" | null>(null);
  const [deleting, setDeleting] = useState<TemplateKit | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    apiFetch<{ templates: RawTemplate[] }>("/templates")
      .then((d) => setTemplates(d.templates.map(parseTemplate)))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load, activeWorkspace?.id]);

  const visible = useMemo(() => templates.filter((t) =>
    (pillar === "all" || groupOf(t) === pillar) &&
    (format === "all" || (t.mediaUrls.length > 0 && t.format === format))), [templates, pillar, format]);

  const sections = GROUPS
    .map((g) => ({ group: g, items: visible.filter((t) => groupOf(t) === g) }))
    .filter((s) => s.items.length > 0);

  function saved(raw: RawTemplate) {
    const kit = parseTemplate(raw);
    setTemplates((prev) => [kit, ...prev.filter((t) => t.id !== kit.id)]);
    toastSuccess(editing === "new" ? `Template "${kit.name}" saved.` : `Template "${kit.name}" updated.`);
    setEditing(null);
    setViewing(null);
  }

  async function remove() {
    if (!deleting) return;
    const { id, name } = deleting;
    setRemoving(true);
    try {
      await apiFetch(`/templates/${id}`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      toastSuccess(`Template "${name}" deleted.`);
      setViewing(null);
    } catch {
      toastError("Couldn't delete the template.");
    } finally {
      setRemoving(false);
      setDeleting(null);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ backgroundColor: BG, color: TEXT }}>
      <div className="pl-16 pr-4 md:px-8 flex-shrink-0 flex items-center justify-between gap-4" style={{ height: 65, borderBottom: `1px solid ${BORDER}` }}>
        <div className="min-w-0">
          <h1 className="text-lg font-bold">Templates</h1>
          <p className="text-xs mt-0.5 hidden sm:block truncate" style={{ color: MUTED }}>
            {canManage
              ? "Upload the designs for each content type. Marketing picks one and types in the copy."
              : "Designs from the design team for each content type. Pick one and type in the copy."}
          </p>
        </div>
        {canManage && (
          <button type="button" onClick={() => setEditing("new")}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-colors hover:bg-gray-100 flex-shrink-0"
            style={{ backgroundColor: "#ffffff", color: "#0a0a0a" }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New template
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
        <style>{`.template-tile:focus-visible { outline: 2px solid #5b63d3; outline-offset: 3px; border-radius: 14px; }
          .template-tile:hover .template-cover { border-color: #444; }`}</style>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-8">
          <div role="tablist" aria-label="Content pillar" className="flex flex-wrap gap-1">
            {(["all", ...GROUPS] as const).map((g) => (
              <button key={g} type="button" role="tab" aria-selected={pillar === g} onClick={() => setPillar(g)}
                className="px-3 py-1.5 rounded-lg text-sm font-medium"
                style={{ color: pillar === g ? TEXT : MUTED, background: pillar === g ? "#1a1a1a" : "transparent", border: `1px solid ${pillar === g ? BORDER : "transparent"}` }}>
                {g === "all" ? "All pillars" : g}
              </button>
            ))}
          </div>
          <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)} aria-label="Format"
            className="ml-auto text-sm rounded-lg px-3 py-1.5"
            style={{ background: BG, border: `1px solid ${BORDER}`, color: TEXT }}>
            <option value="all">All formats</option>
            <option value="carousel">Carousel</option>
            <option value="poster">Poster</option>
          </select>
        </div>

        {loading && <p className="text-sm" style={{ color: MUTED }}>Loading templates…</p>}

        {!loading && loadError && (
          <div className="text-center py-16">
            <p className="text-sm mb-4" style={{ color: MUTED }}>Templates didn&apos;t load. Check your connection and try again.</p>
            <button type="button" onClick={load} className="px-4 py-2 rounded-xl text-sm font-semibold transition-colors hover:bg-gray-100"
              style={{ backgroundColor: "#ffffff", color: "#0a0a0a" }}>Try again</button>
          </div>
        )}

        {!loading && !loadError && sections.length === 0 && (
          <div className="text-center py-16 max-w-sm mx-auto">
            <p className="text-sm mb-4" style={{ color: MUTED }}>
              {templates.length > 0
                ? "No templates match these filters."
                : canManage
                  ? "No templates yet. Upload the first design so Marketing can start from it."
                  : "No templates yet. The design team uploads them here."}
            </p>
            {canManage && templates.length === 0 && (
              <button type="button" onClick={() => setEditing("new")} className="px-4 py-2 rounded-xl text-sm font-semibold transition-colors hover:bg-gray-100"
                style={{ backgroundColor: "#ffffff", color: "#0a0a0a" }}>Upload the first template</button>
            )}
          </div>
        )}

        <div className="space-y-12">
          {sections.map(({ group, items }) => (
            <section key={group} aria-labelledby={`pillar-${group}`}>
              <div className="mb-4" style={{ maxWidth: "68ch" }}>
                <h2 id={`pillar-${group}`} className="text-base font-bold">
                  {group} <span className="text-sm font-normal" style={{ color: MUTED }}>{items.length}</span>
                </h2>
                <p className="text-sm mt-0.5" style={{ color: MUTED }}>{GROUP_SUMMARY[group]}</p>
              </div>
              <ul className="grid gap-x-5 gap-y-7 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
                {items.map((t) => <TemplateTile key={t.id} template={t} onOpen={() => setViewing(t)} />)}
              </ul>
            </section>
          ))}
        </div>
      </div>

      {/* Hidden while the editor or delete confirm is on top, so Esc only closes that layer */}
      {viewing && !editing && !deleting && (
        <TemplateDetail
          template={viewing}
          canManage={canManage}
          canUse={canUse}
          onClose={() => setViewing(null)}
          onUse={() => router.push(`/compose?template=${viewing.id}`)}
          onEdit={() => setEditing(viewing)}
          onDelete={() => setDeleting(viewing)}
        />
      )}
      {editing && (
        <TemplateEditor template={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={saved} />
      )}
      {deleting && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)" }}
          onMouseDown={(e) => { if (e.target === e.currentTarget && !removing) setDeleting(null); }}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="delete-template-title"
            className="w-full max-w-sm rounded-2xl p-5" style={{ background: "#111111", border: `1px solid ${BORDER}` }}>
            <h2 id="delete-template-title" className="text-sm font-bold">Delete template</h2>
            <p className="text-sm mt-2 leading-relaxed" style={{ color: MUTED }}>
              Delete <span style={{ color: TEXT }}>&ldquo;{deleting.name}&rdquo;</span>? Marketing can no longer pick it. Posts already made from it keep their designs.
            </p>
            <div className="flex gap-2 mt-5">
              <button type="button" onClick={() => setDeleting(null)} disabled={removing} autoFocus
                className="flex-1 py-2 rounded-xl text-sm" style={{ border: `1px solid ${BORDER}`, color: MUTED }}>Cancel</button>
              <button type="button" onClick={remove} disabled={removing}
                className="flex-1 py-2 rounded-xl text-sm font-semibold disabled:opacity-60" style={{ background: "#7f1d1d", color: "#fca5a5" }}>
                {removing ? "Deleting…" : "Delete template"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// The cover design is the tile — no card chrome around it.
function TemplateTile({ template, onOpen }: { template: TemplateKit; onOpen: () => void }) {
  const cover = toMediaItems(template.mediaUrls.slice(0, 1))[0];
  const stacked = template.mediaUrls.length > 1;
  return (
    <li>
      <button type="button" onClick={onOpen} className="template-tile w-full text-left">
        <div className="relative" style={{ paddingRight: stacked ? 6 : 0, paddingTop: stacked ? 6 : 0 }}>
          {/* Offset edge hints that a carousel has more slides behind the cover */}
          {stacked && <div aria-hidden className="absolute rounded-xl" style={{ inset: "0 0 6px 6px", border: `1px solid ${BORDER}`, background: "#141414" }} />}
          <div className="template-cover relative rounded-xl overflow-hidden flex items-center justify-center transition-colors"
            style={{ aspectRatio: "4 / 5", border: `1px solid ${BORDER}`, background: "#111111" }}>
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cover.previewUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
            ) : (
              <span className="text-xs px-4 text-center" style={{ color: MUTED }}>Caption only</span>
            )}
          </div>
        </div>
        <p className="text-sm font-semibold mt-2.5 leading-snug line-clamp-2">{template.name}</p>
        <p className="text-xs mt-0.5" style={{ color: MUTED }}>
          {template.category ?? "No category"}, {formatSummary(template).toLowerCase()}
        </p>
      </button>
    </li>
  );
}

function TemplateDetail({ template, canManage, canUse, onClose, onUse, onEdit, onDelete }: {
  template: TemplateKit;
  canManage: boolean;
  canUse: boolean;
  onClose: () => void;
  onUse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const media = toMediaItems(template.mediaUrls);
  const [index, setIndex] = useState(0);
  const labels = template.slides.length === media.length ? template.slides.map((s) => s.label) : undefined;

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[900] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.75)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <style>{`.template-detail :focus-visible { outline: 2px solid #5b63d3; outline-offset: 2px; }`}</style>
      <div role="dialog" aria-modal="true" aria-label={template.name}
        className="template-detail flex flex-col md:flex-row overflow-hidden"
        style={{ background: "#111111", border: `1px solid ${BORDER}`, borderRadius: 16, width: "min(1120px, 100%)", height: "min(90vh, 860px)" }}>
        {media.length > 0 && (
          <div className="flex flex-col md:flex-[3] min-h-0 h-[45vh] md:h-auto flex-shrink-0 md:flex-shrink" style={{ borderRight: `1px solid ${BORDER}` }}>
            <MediaStage media={media} index={index} onIndexChange={setIndex} labels={labels} />
          </div>
        )}

        <div className={`flex flex-col min-h-0 ${media.length > 0 ? "md:flex-[2]" : "flex-1"}`} style={{ minWidth: 0 }}>
          <div className="flex items-start gap-3 px-5 pt-5 pb-4 flex-shrink-0" style={{ borderBottom: `1px solid ${BORDER}` }}>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold leading-snug" style={{ color: TEXT }}>{template.name}</h2>
              <p className="text-xs mt-1" style={{ color: MUTED }}>
                {template.category
                  ? `${template.category}${template.pillar ? `, ${template.pillar} pillar` : ""}`
                  : "No category"}
              </p>
              <p className="text-xs mt-0.5" style={{ color: MUTED }}>{formatSummary(template)}</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close"
              className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ color: MUTED, border: `1px solid ${BORDER}` }}>✕</button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5" style={{ maxWidth: "68ch" }}>
            {template.slides.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold mb-1.5" style={{ color: MUTED }}>Copy each slide needs</h3>
                <ol className="space-y-1.5">
                  {template.slides.map((s, i) => {
                    const active = labels !== undefined && i === index;
                    return (
                      <li key={i}>
                        <button type="button" onClick={() => setIndex(i)} aria-current={active}
                          className="w-full text-left rounded-xl px-3 py-2.5"
                          style={{ background: active ? "#1a1a1a" : "transparent", border: `1px solid ${active ? "#5b63d3" : BORDER}` }}>
                          <span className="block text-xs font-semibold" style={{ color: active ? TEXT : MUTED }}>{s.label}</span>
                          <span className="block text-sm leading-relaxed whitespace-pre-wrap break-words mt-0.5" style={{ color: s.guide ? TEXT : MUTED }}>
                            {s.guide || "No guidance"}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}
            <section>
              <h3 className="text-xs font-semibold mb-1.5" style={{ color: MUTED }}>Caption draft</h3>
              <p className="text-sm leading-relaxed whitespace-pre-wrap break-words" style={{ color: template.text ? TEXT : MUTED }}>
                {template.text || "No caption draft"}
              </p>
            </section>
            {template.commentText && (
              <section>
                <h3 className="text-xs font-semibold mb-1.5" style={{ color: MUTED }}>First comment</h3>
                <p className="text-sm leading-relaxed whitespace-pre-wrap break-words" style={{ color: TEXT }}>{template.commentText}</p>
              </section>
            )}
          </div>

          {(canManage || canUse) && (
            <div className="flex gap-2 px-5 py-4 flex-shrink-0" style={{ borderTop: `1px solid ${BORDER}` }}>
              {canManage && (
                <>
                  <button type="button" onClick={onDelete}
                    className="px-4 py-2 rounded-xl text-sm font-semibold" style={{ border: "1px solid #7f1d1d", color: "#fca5a5" }}>
                    Delete
                  </button>
                  <button type="button" onClick={onEdit}
                    className="flex-1 py-2 rounded-xl text-sm font-semibold transition-colors hover:bg-gray-100"
                    style={{ backgroundColor: "#ffffff", color: "#0a0a0a" }}>
                    Edit template
                  </button>
                </>
              )}
              {canUse && (
                <button type="button" onClick={onUse}
                  className="flex-1 py-2 rounded-xl text-sm font-semibold transition-colors hover:bg-gray-100"
                  style={{ backgroundColor: "#ffffff", color: "#0a0a0a" }}>
                  Use template
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
