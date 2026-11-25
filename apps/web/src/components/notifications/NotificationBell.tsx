"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BellIcon, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { assetUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  badgeText,
  drawerSubtitle,
  groupNotifications,
  notificationHref,
  notificationTime,
  notificationWords,
  type NotificationItem,
} from "@/lib/notifications";
import { useNotifications } from "@/lib/useNotifications";

const PILL = {
  neutral: "bg-neutral-50 text-neutral-800",
  success: "bg-green-600/10 text-green-700",
  danger: "bg-red-500/10 text-red-600",
  info: "bg-blue-600/10 text-blue-700",
} as const;

const DOT = { neutral: "bg-neutral-500", success: "bg-green-600", danger: "bg-red-500", info: "bg-blue-600" } as const;

function Thumb({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="flex h-12 w-10 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-neutral-700">
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={assetUrl(src)} alt="" loading="lazy" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <ImageIcon aria-hidden="true" className="size-4 text-neutral-300" />
      )}
    </span>
  );
}

function Row({ n, now, onOpen }: { n: NotificationItem; now: Date; onOpen: (n: NotificationItem) => void }) {
  const words = notificationWords(n);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(n)}
        className={cn(
          "flex w-full cursor-pointer items-start gap-3 rounded-xl px-3 py-3 text-left outline-none transition-colors hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-ring/40",
          !n.read && "bg-brand-100/60",
        )}
      >
        <Thumb src={n.thumbnail} />
        <span className="min-w-0 flex-1">
          <span className="block truncate type-body-m-s text-fg" title={n.title}>
            {n.title}
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 type-body-sb-xxs whitespace-nowrap", PILL[words.tone])}>
              <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[words.tone])} />
              {words.pill}
            </span>
            <span className="min-w-0 truncate type-body-r-xs text-muted">{words.line}</span>
          </span>
          <span className="mt-1 block type-body-r-xxs text-muted">{notificationTime(n.at, now)}</span>
        </span>
        {!n.read && (
          <>
            <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-500" />
            <span className="sr-only">Unread</span>
          </>
        )}
      </button>
    </li>
  );
}

function Group({ label, items, now, onOpen }: { label: string; items: NotificationItem[]; now: Date; onOpen: (n: NotificationItem) => void }) {
  if (items.length === 0) return null;
  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <h3 className="px-3 pt-2 type-body-r-xs tracking-wide text-muted uppercase">{label}</h3>
      <ul className="flex flex-col gap-1">
        {items.map((n) => (
          <Row key={n.id} n={n} now={now} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The bell of the top bar and the drawer it opens (docs/design/designer/drawer-notifications): one list for every role,
 * grouped Today and Earlier, the unread ones tinted with a dot. A click marks the row read and goes where it points.
 */
export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { unread, items, loading, error, load, markRead, markAllRead } = useNotifications();
  // read when the drawer opens, so "Today" is today for as long as the drawer is open
  const now = useMemo(() => new Date(), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupNotifications(items ?? [], now), [items, now]);
  const badge = badgeText(unread);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) load();
  }

  function go(n: NotificationItem) {
    markRead(n);
    const href = notificationHref(n);
    setOpen(false);
    if (href) router.push(href);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button variant="secondary" size="icon" aria-label={badge ? `Notifications, ${unread} unread` : "Notifications"} className="relative rounded-full bg-surface">
              <BellIcon />
              {badge && (
                <span aria-hidden="true" className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 type-body-sb-xxs text-white tabular-nums">
                  {badge}
                </span>
              )}
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>Notifications</TooltipContent>
      </Tooltip>

      <SheetContent side="right" className="gap-0 bg-surface p-0 sm:max-w-md" showCloseButton>
        <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
          <SheetTitle className="type-head-sb-5">Notification</SheetTitle>
          <SheetDescription>{items ? drawerSubtitle(items.length, unread) : "Loading…"}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-busy={loading}>
          {error && !items && (
            <p role="alert" className="px-3 py-6 type-body-r-s text-red-600">
              We couldn&apos;t load your notifications. {error}{" "}
              <Button variant="link" size="sm" className="inline-flex h-auto p-0" onClick={load}>
                Try again
              </Button>
            </p>
          )}
          {!items && loading && <p className="px-3 py-6 type-body-r-s text-muted">Loading…</p>}
          {items && items.length === 0 && <p className="px-3 py-10 text-center type-body-r-s text-muted">You&apos;re all caught up.</p>}
          {items && items.length > 0 && (
            <div className="flex flex-col gap-2">
              <Group label="Today" items={groups.today} now={now} onOpen={go} />
              <Group label="Earlier" items={groups.earlier} now={now} onOpen={go} />
            </div>
          )}
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-border p-4">
          <Button variant="secondary" disabled={unread === 0} onClick={markAllRead}>
            Mark all as read
          </Button>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
