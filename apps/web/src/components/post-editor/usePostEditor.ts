"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Account } from "@/components/PlatformPreview";
import { useToast } from "@/components/Toast";
import { useWorkspace } from "@/context/WorkspaceContext";
import { apiFetch } from "@/lib/api";
import { normalizeCategory } from "@/lib/contentTypes";
import { fetchJob, submitForReview } from "@/lib/jobActions";
import type { DesignRequestView, Job } from "@/lib/jobTypes";
import {
  EMPTY_FORM,
  actionsFor,
  changedFields,
  contentChanged,
  createBody,
  editBlock,
  editorMissing,
  formFromJob,
  parseContent,
  saveBlock,
  scheduleBlock,
  scheduledOf,
  submitBlock,
  type PostForm,
} from "@/lib/post-editor";
import { useUnsavedChanges } from "@/lib/session";
import { missingMessage } from "@/lib/submitReadiness";
import { templatesByCategory } from "@/lib/templates";
import { trackEvent } from "@/lib/track";
import { usePermissions } from "@/lib/usePermissions";
import { useTemplates } from "@/lib/useTemplates";

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");

type Busy = "draft" | "primary" | null;

/**
 * Everything the Edit Content page keeps: the post (when it exists), the form and the form as it was loaded, the accounts and
 * templates, and what each button does. `jobId` null is Add: the post is created the first time something needs it (Save as
 * Draft, Submit, Studio, Save brief) and the page then moves to /jobs/<id>/edit.
 *
 * A save sends only the keys that changed (lib/post-editor `changedFields`), so what the page does not show is never touched.
 */
export function usePostEditor(jobId: string | null) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const perms = usePermissions();
  const { activeWorkspace } = useWorkspace();
  const templatesState = useTemplates();

  const [job, setJob] = useState<Job | null>(null);
  const [load, setLoad] = useState<"loading" | "ready" | "missing" | "error">(jobId ? "loading" : "ready");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [initial, setInitial] = useState<PostForm>(EMPTY_FORM);
  const [form, setForm] = useState<PostForm>(EMPTY_FORM);
  const [briefDirty, setBriefDirty] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  /** The Studio is being opened: it saves on the post by itself, so no other save runs meanwhile (two writes of one post's JSON would lose one). */
  const [opening, setOpening] = useState(false);
  /** Add mode: the draft that was created for Studio or a brief, before the page moves to its edit URL. */
  const [createdId, setCreatedId] = useState<string | null>(null);

  const postId = jobId ?? createdId;
  const creating = useRef<Promise<string> | null>(null);

  const adopt = useCallback((j: Job) => {
    const f = formFromJob(j);
    setJob(j);
    setInitial(f);
    setForm(f);
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let live = true;
    setLoad("loading");
    fetchJob(jobId)
      .then((j) => {
        if (!live) return;
        adopt(j);
        setLoad("ready");
      })
      .catch((e: unknown) => {
        if (!live) return;
        setLoad((e as { status?: number })?.status === 404 ? "missing" : "error");
        setLoadError(messageOf(e));
      });
    return () => {
      live = false;
    };
  }, [jobId, adopt]);

  useEffect(() => {
    apiFetch<Account[]>("/accounts").then(setAccounts).catch(() => {});
  }, []);

  // Opened from the Template Library (/compose?template=<id>): the template's pillar and category are filled in, and only
  // those. The parameter is taken out of the address, and any other one (?design=) stays.
  const templates = templatesState.data?.templates;
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (jobId || prefilled || !templates) return;
    setPrefilled(true);
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("template");
    if (!requested) return;
    const tpl = templates.find((t) => t.id === requested);
    if (tpl) {
      const fill = { pillar: tpl.pillar, category: tpl.category as string };
      setInitial((f) => ({ ...f, ...fill }));
      setForm((f) => ({ ...f, ...fill }));
    }
    params.delete("template");
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  }, [jobId, prefilled, templates]);

  const set = useCallback((patch: Partial<PostForm>) => setForm((f) => ({ ...f, ...patch })), []);

  const changes = useMemo(() => changedFields(initial, form), [initial, form]);
  const dirty = Object.keys(changes).length > 0 || briefDirty;
  useUnsavedChanges("post-editor", dirty);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ── What the page may do ──────────────────────────────────────────────────
  const stored = useMemo(() => parseContent(job?.content ?? "{}"), [job]);
  const request: DesignRequestView | null = job?.designRequest ?? null;
  const isNew = postId === null;
  const status = job?.status ?? "draft";
  const approvalStatus = job?.approvalStatus ?? null;
  const readOnlyReason = job ? editBlock(job, perms) : perms.canEditContent ? null : "Your role can't edit content.";
  const approvalFlow = Boolean(activeWorkspace?.approvalRequired);
  const missing = useMemo(() => editorMissing(stored, form, accounts), [stored, form, accounts]);
  const actions = actionsFor({ isNew, status, approvalStatus, canReview: perms.canReview, canSubmitOwn: perms.canSubmitOwn });
  const category = normalizeCategory(form.category);
  const template = category && templates ? templatesByCategory(templates).get(category) ?? null : null;

  const link = saveBlock(form);
  const primaryBlock =
    link ??
    (actions.primary?.kind === "submit"
      ? submitBlock({ approvalStatus, contentChanged: contentChanged(initial, form), request }) ?? missingMessage(missing)
      : actions.primary?.kind === "schedule"
        ? scheduleBlock(form, request)
        : null);

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * The post's id, creating the draft in Add mode. The page then holds the post like an edit does, and its address becomes
   * /jobs/<id>/edit without a navigation (the form, the open path and the Studio tab stay as they are). In an edit it saves
   * nothing: an edit sends its changes with Save.
   */
  async function ensurePost(): Promise<string> {
    if (postId) return postId;
    // Two actions at once (Studio, then Save as Draft) must make ONE draft: the second waits for the first
    creating.current ??= create().finally(() => { creating.current = null; });
    return creating.current;
  }

  async function create(): Promise<string> {
    const sent = form;
    const created = await apiFetch<{ id: string }>("/jobs", { method: "POST", body: JSON.stringify(createBody(sent, true)) });
    const saved = await fetchJob(created.id);
    setJob(saved);
    setCreatedId(created.id);
    // the designs as the SERVER stored them (it measured each picture): the warning about a channel needs that size
    const designs = formFromJob(saved).canvasDesigns;
    setInitial({ ...sent, canvasDesigns: designs });
    setForm((f) => ({ ...f, canvasDesigns: designs }));
    window.history.replaceState(null, "", `/jobs/${created.id}/edit`);
    return created.id;
  }

  /** A save: creates the draft in Add mode, else sends the changed keys (nothing at all when none changed). */
  async function persist(): Promise<string> {
    if (!postId) return ensurePost();
    const body = changedFields(initial, form);
    if (Object.keys(body).length > 0) {
      const saved = await apiFetch<{ content: string }>(`/jobs/${postId}`, { method: "PATCH", body: JSON.stringify(body) });
      // adopt the designs the server stored (their measured sizes); every other field stays as the person has it
      const designs = saved?.content ? formFromJob({ content: saved.content, scheduledFor: null, targets: [] }).canvasDesigns : form.canvasDesigns;
      setInitial({ ...form, canvasDesigns: designs });
      setForm((f) => ({ ...f, canvasDesigns: designs }));
    }
    return postId;
  }

  async function reloadJob(id: string) {
    adopt(await fetchJob(id));
  }

  async function run(kind: Exclude<Busy, null>, work: () => Promise<void>) {
    setBusy(kind);
    try {
      await work();
    } catch (e) {
      toastError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  const saveDraft = () =>
    run("draft", async () => {
      const id = await persist();
      success("Draft saved.");
      await reloadJob(id);
    });

  const savePrimary = () =>
    run("primary", async () => {
      const id = await persist();
      success("Post updated.");
      await reloadJob(id);
    });

  const submit = () =>
    run("primary", async () => {
      const id = await persist();
      await submitForReview(id);
      success("Sent for design review: waiting for approval.");
      router.push("/jobs");
    });

  const schedule = () =>
    run("primary", async () => {
      let id = postId;
      if (id) {
        id = await persist();
        await apiFetch(`/jobs/${id}/schedule`, { method: "POST", body: JSON.stringify({ scheduledFor: scheduledOf(form)!.toISOString() }) });
      } else {
        await apiFetch("/jobs", { method: "POST", body: JSON.stringify(createBody(form, false)) });
      }
      success("Post scheduled.");
      void trackEvent("post_scheduled", { platforms: accounts.filter((a) => form.accountIds.includes(a.id)).map((a) => a.platform) });
      window.dispatchEvent(new CustomEvent("ph:post-scheduled"));
      router.push("/jobs");
    });

  /** The post's id with its unsaved changes saved: a request is checked against the SAVED publishing date, so that is the one the person sees. */
  async function ensureSaved(): Promise<string> {
    const id = await ensurePost();
    if (id === postId) return persist();
    return id;
  }

  /** The Studio saved a design on the post: kept in the page's copy, so the form's unsaved edits are not reset. */
  function noteCanvas(ids: { canvasInstanceId: string; canvasTemplateId: string }) {
    setJob((j) => (j ? { ...j, content: JSON.stringify({ ...parseContent(j.content), ...ids }) } : j));
  }

  return {
    // state
    job, stored, load, loadError, accounts, templates, templatesLoading: templatesState.loading, form, initial, set, dirty, uploading, setUploading, opening, setOpening, saveBlocked: link,
    briefDirty, setBriefDirty, busy, request, setRequest: (r: DesignRequestView | null) => setJob((j) => (j ? { ...j, designRequest: r } : j)),
    // what the page may do
    isNew, postId, status, approvalStatus, readOnlyReason, approvalFlow, missing, actions, primaryBlock, template, perms,
    // actions
    ensurePost, ensureSaved, saveDraft, savePrimary, submit, schedule, noteCanvas,
  };
}

export type PostEditor = ReturnType<typeof usePostEditor>;
