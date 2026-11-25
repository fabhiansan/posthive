"use client";

import { CircleHelpIcon } from "lucide-react";
import { ContentTypeSelects } from "@/components/ContentTypeSelects";
import { DatePicker } from "@/components/DatePicker";
import { InlineAlert } from "@/components/InlineAlert";
import type { Account } from "@/components/PlatformPreview";
import { countGraphemes, PLATFORM_LIMIT } from "@/components/PlatformPreview";
import { TimeInput24 } from "@/components/TimeInput24";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { approvalLabel, captionLimit } from "@/lib/content-list";
import { wibDateKey } from "@/lib/datetime";
import {
  FORMAT_OPTIONS,
  designLinkProblem,
  formatLine,
  legacyNotes,
  withMainCaption,
  type PostForm,
  type PostFormat,
  type StoredContent,
} from "@/lib/post-editor";
import { PlatformCards } from "./PlatformCards";

type Props = {
  form: PostForm;
  set: (patch: Partial<PostForm>) => void;
  stored: StoredContent;
  post: { status: string; approvalStatus: string | null; commentText: string | null } | null;
  accounts: Account[];
  canConnect: boolean;
  /** Read only: nothing here can be changed (the post is locked for this person). */
  locked: boolean;
};

/** Marks a required field: the asterisk of the design, hidden from a screen reader (the field says required). */
const Req = () => <span className="text-red-600" aria-hidden="true"> *</span>;

const LABEL = "type-body-sb-xs text-muted";

/** A link the designer is given. A plan import may have left plain text here: it shows as it is, and only a change to it has to be a link. */
function LinkField({ label, value, was, onChange, placeholder }: { label: string; value: string; was: string; onChange: (v: string) => void; placeholder: string }) {
  const problem = value !== was ? designLinkProblem(value) : null;
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <Input value={value} maxLength={500} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="mt-1.5" aria-invalid={problem ? true : undefined} />
      {problem && <span role="alert" className="mt-1.5 block type-body-r-xs text-red-600">{problem}</span>}
    </label>
  );
}

/** Card A of the Edit Content page: what the post says, what it is, when it goes out and where. */
export function BasicInfoCard({ form, set, stored, post, accounts, canConnect, locked }: Props) {
  const channels = accounts.filter((a) => form.accountIds.includes(a.id)).map((a) => a.platform);
  const limit = captionLimit(channels, PLATFORM_LIMIT);
  const length = countGraphemes(form.text);
  const over = limit !== null && length > limit;
  const notes = legacyNotes(form, accounts, post?.commentText);
  const today = wibDateKey(new Date());
  const files = form.mediaUrls.length;
  const line = formatLine(form.format, files);

  return (
    <Card className="gap-5 border-0 p-5" role="region" aria-labelledby="basic-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="basic-heading" className="type-body-sb-m text-fg">A · Basic content information</h2>
        <p className="min-w-0 truncate text-right type-body-r-xs text-muted">{stored.importSource ? "Pre-filled from import · editable while Draft" : "Editable while Draft"}</p>
      </div>

      {stored.importSource?.fileName && (
        <p className="rounded-xl bg-red-50/60 px-3.5 py-2.5 type-body-r-xs text-neutral-600">
          Linked to {stored.importSource.fileName}
          {typeof stored.sourceRow === "number" ? ` · row ${stored.sourceRow}` : ""}. Changes are saved to this post and keep the link to the import.
        </p>
      )}

      <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
        <label className="block">
          <span className={LABEL}>Content title<Req /></span>
          <Input value={form.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} className="mt-1.5" required aria-required="true" />
        </label>

        <div>
          <label className="block">
            <span className={LABEL}>Content description / caption<Req /></span>
            <Textarea value={form.text} onChange={(e) => set({ text: e.target.value })} rows={6} className="mt-1.5 resize-y" aria-required="true" aria-invalid={over || undefined} />
          </label>
          <p className={over ? "mt-1.5 flex items-center gap-1.5 type-body-r-xs text-red-600" : "mt-1.5 flex items-center gap-1.5 type-body-r-xs text-muted"} role={over ? "alert" : undefined}>
            <CircleHelpIcon aria-hidden="true" className="size-3.5" />
            {length.toLocaleString("en-US")}
            {limit ? ` / ${limit.toLocaleString("en-US")}` : ""} characters
            {over ? ` · ${(length - limit).toLocaleString("en-US")} over what ${channels.length > 1 ? "the smallest channel" : "the channel"} takes` : ""}
          </p>
        </div>

        <ContentTypeSelects pillar={form.pillar} category={form.category} onChange={(t) => set({ pillar: t.pillar, category: t.category })} idPrefix="editor" />

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL}>Content format<Req /></span>
            <NativeSelect value={form.format} onChange={(e) => set({ format: e.target.value as PostFormat | "" })} containerClassName="mt-1.5" aria-required="true">
              <NativeSelectOption value="">Choose a format</NativeSelectOption>
              {FORMAT_OPTIONS.map((f) => (
                <NativeSelectOption key={f.value} value={f.value}>{f.value === "carousel" && line?.startsWith("Carousel") ? line : f.label}</NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <div>
            <span className={LABEL}>Approval status</span>
            <p className="mt-1.5 rounded-xl bg-neutral-50 px-3 py-2 type-body-r-s text-fg">
              {post ? `${post.status === "draft" ? "Draft" : "Scheduled"} · ${approvalLabel(post).toLowerCase()}` : "Draft · not submitted"}
            </p>
          </div>
        </div>
        <p className="-mt-3 type-body-r-xs text-muted">Approval status is set by the review workflow. It changes when you submit for review.</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span className={LABEL}>Publishing date<Req /></span>
            <div className="mt-1.5">
              <DatePicker value={form.date} onChange={(date) => set({ date })} min={today} placeholder="Pick a date" required />
            </div>
          </div>
          <div>
            <span className={LABEL}>Publishing time (WIB)<Req /></span>
            <TimeInput24 value={form.time} onChange={(time) => set({ time })} className="mt-1.5" label="Publishing" />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <LinkField label="Copywriting link (optional)" value={form.designCopy} was={stored.designCopy ?? ""} onChange={(designCopy) => set({ designCopy })} placeholder="https://docs.google.com/…" />
          <LinkField label="Supporting assets link (optional)" value={form.assetNotes} was={stored.assetNotes ?? ""} onChange={(assetNotes) => set({ assetNotes })} placeholder="https://drive.google.com/…" />
        </div>
        <p className="-mt-3 type-body-r-xs text-muted">The designer opens these from their task. A plan import fills them in.</p>

        <PlatformCards accounts={accounts} accountIds={form.accountIds} onChange={(accountIds) => set({ accountIds })} canConnect={canConnect} disabled={locked} />
      </fieldset>

      {(notes.otherChannels.length > 0 || notes.customText || notes.firstComment) && (
        <InlineAlert tone="info" className="border-0">
          <ul className="list-disc space-y-1 pl-4">
            {notes.otherChannels.length > 0 && <li>This post also goes to {notes.otherChannels.join(", ")}, set up before this editor. It stays as it is.</li>}
            {notes.firstComment && <li>It has a first comment. It stays as it is.</li>}
            {notes.customText && (
              <li>
                A channel has its own caption, and that text is posted instead of the one above.{" "}
                {!locked && (
                  <Button variant="link" className="inline h-auto p-0 type-body-sb-xs" onClick={() => set({ perAccount: withMainCaption(form.perAccount) })}>
                    Use the main caption
                  </Button>
                )}
              </li>
            )}
          </ul>
        </InlineAlert>
      )}
    </Card>
  );
}
