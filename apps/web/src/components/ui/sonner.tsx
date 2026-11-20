"use client"

import * as React from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/cn"
import { TONE } from "@/lib/tone"

export type ToastType = "success" | "error" | "warning" | "info"

const ICONS = {
  success: CheckIcon,
  error: XIcon,
  warning: TriangleAlertIcon,
  info: InfoIcon,
} as const

// box: panel + text / icon colour (lib/tone.ts); icon: the round badge behind the icon.
const TONES: Record<ToastType, { box: string; icon: string }> = {
  success: { box: TONE.success, icon: "bg-green-100" },
  error: { box: TONE.danger, icon: "bg-red-100" },
  warning: { box: TONE.warning, icon: "bg-brand-200" },
  info: { box: TONE.info, icon: "bg-blue-100" },
}

// What one toast looks like. sonner places it, stacks it, times it and lets it be swiped away.
// Errors and warnings interrupt a screen reader, the rest are polite (same rule as Alert).
function ToastCard({
  type,
  message,
  onDismiss,
  className,
}: {
  type: ToastType
  message: React.ReactNode
  onDismiss: () => void
  className?: string
}) {
  const tone = TONES[type]
  const Icon = ICONS[type]
  return (
    <div
      data-slot="toast"
      data-type={type}
      role={type === "error" || type === "warning" ? "alert" : "status"}
      className={cn(
        "flex w-full items-start gap-3 rounded-2xl border px-4 py-3 shadow-2xl",
        tone.box,
        className
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
          tone.icon
        )}
      >
        <Icon className="size-3" strokeWidth={2.5} aria-hidden="true" />
      </div>
      <p className="min-w-0 flex-1 type-body-r-s">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="mt-0.5 shrink-0 cursor-pointer rounded-sm transition-opacity outline-none hover:opacity-60 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

// Mount once, in the root layout. Bottom right like before, up to 5 toasts, fanned out. A toast that asks for the top
// right (useToast("top-right")) sits under the header's actions: measured in the browser, the avatar ends 32px from the
// right (the shell's 8px margin and the page's 24px padding) and 72px from the top, and the toast starts 12px below it.
// shortcut: fixed numbers, as the header of a page is. On a page wider than its 110rem column the avatar moves in from the
// edge and a page with a trial banner above its header is pushed down: the toast then no longer lines up with the avatar.
const OFFSET = { top: 84, right: 32, bottom: 24, left: 24 }
const MOBILE_OFFSET = { top: 16, right: 16, bottom: 16, left: 16 }

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      position="bottom-right"
      visibleToasts={5}
      expand
      gap={8}
      offset={OFFSET}
      mobileOffset={MOBILE_OFFSET}
      containerAriaLabel="Notifications"
      {...props}
    />
  )
}

export { Toaster, ToastCard }
