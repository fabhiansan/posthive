// What a person can do to a post from the Content List, as plain calls to the API. Moved here from the old
// Posts page as they were (same routes, same bodies); the page owns the toasts and the reloading.
import { apiFetch } from "./api";
import type { DesignRequestView, Job } from "./jobTypes";

/** The whole post, as the editor page and the review dialog take it. */
export const fetchJob = (id: string) => apiFetch<Job>(`/jobs/${id}`);

/** Approve = schedule: the creator's requested time if it is still ahead, else five minutes from now. */
export function approveJob(job: Job): Promise<Job> {
  const requested = job.scheduledFor ? new Date(job.scheduledFor) : null;
  const when = requested && requested > new Date() ? requested.toISOString() : new Date(Date.now() + 5 * 60_000).toISOString();
  return apiFetch<Job>(`/jobs/${job.id}/schedule`, { method: "POST", body: JSON.stringify({ scheduledFor: when }) });
}

export const rejectJob = (job: Job, note: string) => apiFetch<Job>(`/jobs/${job.id}/reject`, { method: "POST", body: JSON.stringify({ note }) });

export const submitForReview = (id: string) => apiFetch<Job>(`/jobs/${id}/submit`, { method: "POST" });

export interface BulkSubmitResult {
  submitted: string[];
  skipped: { id: string; title: string; reason: string; missing?: string[] }[];
}

export const submitMany = (ids: string[]) => apiFetch<BulkSubmitResult>("/jobs/submit-bulk", { method: "POST", body: JSON.stringify({ ids }) });

export const retryFailed = (id: string) => apiFetch(`/jobs/${id}/retry-failed`, { method: "POST" });

export const deleteJob = (id: string) => apiFetch(`/jobs/${id}`, { method: "DELETE" });

/** One request for many; if it fails the posts are deleted one by one, so a partial success still counts. */
export async function deleteMany(ids: string[]): Promise<number> {
  try {
    const res = await apiFetch<{ deleted: number }>("/jobs/bulk", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
    return res.deleted;
  } catch {
    let deleted = 0;
    for (const id of ids) {
      try {
        await apiFetch(`/jobs/${id}`, { method: "DELETE" });
        deleted++;
      } catch { /* the next one may still go */ }
    }
    return deleted;
  }
}

/** A designer of the workspace, for the "Designer (PIC)" select. */
export interface Designer {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export const listDesigners = () => apiFetch<{ designers: Designer[] }>("/design-requests/designers").then((d) => d.designers);

export interface DesignRequestInput {
  assigneeId: string;
  /** An ISO instant, or null for no deadline (optional). */
  deadline: string | null;
  brief: string;
  referenceUrl: string;
  /** false saves the brief; true sends it to the designer and locks it. */
  send: boolean;
}

export const saveDesignRequest = (jobId: string, body: DesignRequestInput) =>
  apiFetch<{ request: DesignRequestView }>(`/jobs/${jobId}/design-request`, { method: "PUT", body: JSON.stringify(body) }).then((r) => r.request);

export const cancelDesignRequest = (jobId: string) =>
  apiFetch<{ request: DesignRequestView }>(`/jobs/${jobId}/design-request/cancel`, { method: "POST" }).then((r) => r.request);
