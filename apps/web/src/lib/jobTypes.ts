// The post as the API's /jobs routes send it (the whole row, content JSON included). The dialogs for editing and
// reviewing a post take this shape; the Content List itself reads the lighter shapes of lib/content-list.ts.

export interface JobTarget {
  id: string;
  accountId: string;
  status: string;
  platformPostId: string | null;
  error: string | null;
  attempts: number;
  account: { platform: string; displayName: string; avatarUrl: string | null } | null;
}

/** A request from Marketing to a designer for the design of one post (Path B). `deadline` is an ISO instant, or null: it is optional. */
export interface DesignRequestView {
  id: string;
  status: string; // draft = a saved brief | sent = with the designer, locked | done = the designer sent the design, locked
  /** `active` is false once they left the design team; null once their account is gone. */
  assignee: { id: string; name: string; avatarUrl: string | null; active: boolean } | null;
  deadline: string | null;
  brief: string;
  referenceUrl: string | null;
  sentAt: string | null;
  updatedAt: string;
  /** The designer's answer, only once the request is done; until then the link and note are the designer's own draft. */
  doneAt: string | null;
  figmaUrl: string | null;
  designerNote: string | null;
}

export interface Job {
  id: string;
  userId?: string;
  scheduledFor: string | null;
  status: string;
  content: string;
  commentText: string | null;
  dryRun: boolean;
  createdAt: string;
  updatedAt?: string;
  designRequest?: DesignRequestView | null;
  repeatInterval?: string | null;
  repeatParentId?: string | null;
  approvalStatus?: string | null; // pending | approved | rejected | null
  reviewNote?: string | null;
  reviewedBy?: { name: string } | null;
  reviewedAt?: string | null;
  targets: JobTarget[];
}
