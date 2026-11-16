"use client";

import { useState, type ReactNode } from "react";
import { Trash2Icon, TriangleAlertIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/cn";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Extra content under the description, e.g. a preview of the post. */
  children?: ReactNode;
  confirmLabel?: string;
  /** Shown on the confirm button while onConfirm runs. */
  pendingLabel?: string;
  cancelLabel?: string;
  /** "danger" = red icon tile and red button (delete, disconnect, cancel plan). */
  tone?: "danger" | "default";
  /** Replace the tone's icon. */
  icon?: ReactNode;
  /** Keep the confirm button off until what the dialog asks for (a password, a typed name) is there. */
  confirmDisabled?: boolean;
  /**
   * What to do on confirm. While it runs both buttons are disabled and the dialog cannot be
   * closed; when it resolves the dialog closes. Handle errors inside it (toast); if it rejects
   * the dialog stays open so the user can try again (the rejection is not rethrown).
   */
  onConfirm: () => void | Promise<void>;
};

/**
 * The one confirm dialog (delete a post, disconnect an account, leave a workspace…).
 * Esc and Cancel never confirm, and a click on the backdrop does nothing.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  pendingLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  icon,
  confirmDisabled = false,
  onConfirm,
}: Props) {
  const [pending, setPending] = useState(false);
  const danger = tone === "danger";

  async function handleConfirm(e: React.MouseEvent) {
    // Radix would close the dialog right away; we close it once onConfirm has finished.
    e.preventDefault();
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      // onConfirm has already told the person what went wrong: the dialog stays open for another try
      console.error("ConfirmDialog: onConfirm failed", e);
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <AlertDialogContent>
        <div className="flex items-start gap-4">
          <AlertDialogMedia className={cn(danger && "border-red-200 bg-red-50 text-red-600")}>
            {icon ?? (danger ? <Trash2Icon /> : <TriangleAlertIcon />)}
          </AlertDialogMedia>
          <AlertDialogHeader className="min-w-0 flex-1">
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
            {children}
          </AlertDialogHeader>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction variant={danger ? "destructive" : "default"} disabled={pending || confirmDisabled} onClick={handleConfirm}>
            {pending && pendingLabel ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
