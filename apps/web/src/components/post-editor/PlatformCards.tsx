"use client";

import Link from "next/link";
import { AccountAvatar } from "@/components/AccountAvatar";
import type { Account } from "@/components/PlatformPreview";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/cn";
import { platformLabel } from "@/lib/platforms";
import { EDITOR_PLATFORMS } from "@/lib/post-editor";

const SIZE: Record<string, string> = { linkedin: "Company page · 1080×1350", instagram: "Feed · 1080×1350" };

type Props = {
  accounts: Account[];
  accountIds: string[];
  onChange: (ids: string[]) => void;
  /** An admin can connect one; Marketing is told to ask. */
  canConnect: boolean;
  disabled?: boolean;
};

/** The channels the post goes to: one card per connected LinkedIn or Instagram account, and what is missing when a platform has none. */
export function PlatformCards({ accounts, accountIds, onChange, canConnect, disabled }: Props) {
  const toggle = (id: string) => onChange(accountIds.includes(id) ? accountIds.filter((x) => x !== id) : [...accountIds, id]);
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="type-body-sb-xs text-fg">
        Publishing platform / channel <span className="text-red-600" aria-hidden="true">*</span>
        <span className="ml-1 type-body-r-xs text-muted">select at least one</span>
      </legend>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {EDITOR_PLATFORMS.map((platform) => {
          const ofPlatform = accounts.filter((a) => a.platform === platform);
          if (ofPlatform.length === 0) {
            return (
              <div key={platform} className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3">
                <span className="min-w-0">
                  <span className="block type-body-sb-s text-muted">{platformLabel(platform)}</span>
                  <span className="block type-body-r-xs text-muted">
                    Not connected.{" "}
                    {canConnect ? <Link href="/accounts" className="text-brand-800 underline underline-offset-2">Connect it</Link> : "Ask an admin to connect it."}
                  </span>
                </span>
              </div>
            );
          }
          return ofPlatform.map((a) => {
            const on = accountIds.includes(a.id);
            return (
              <label key={a.id} className={cn("flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors", on ? "border-brand-500 bg-brand-100/40" : "border-border bg-surface hover:bg-neutral-50")}>
                <Checkbox checked={on} onCheckedChange={() => toggle(a.id)} aria-label={`${platformLabel(platform)}: ${a.displayName}`} />
                <AccountAvatar platform={a.platform} avatarUrl={a.avatarUrl} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate type-body-sb-s text-fg">{a.displayName}</span>
                  <span className="block type-body-r-xs text-muted">{SIZE[platform]}</span>
                </span>
              </label>
            );
          });
        })}
      </div>
    </fieldset>
  );
}
