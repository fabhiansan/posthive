"use client";

import { toast as sonner } from "sonner";
import { ToastCard, type ToastType } from "@/components/ui/sonner";

export type { ToastType };

// sonner owns placement, stacking, timers and swiping; <Toaster /> in the root layout renders it.
// This file keeps the API every page already uses: const { toast, success, error, danger, warning } = useToast().
// A page that shows its own header (the Template Library) asks for its toasts under that header: useToast("top-right").
// The default stays where it always was, at the bottom right.
export type ToastPosition = "top-right";

const DEFAULT_MS = 4000;
const ERROR_MS = 6000; // errors stay a little longer

function show(message: string, type: ToastType = "info", duration: number = DEFAULT_MS, position?: ToastPosition) {
  sonner.custom(
    (id) => <ToastCard type={type} message={message} onDismiss={() => sonner.dismiss(id)} />,
    // no position: the Toaster's own (bottom right)
    position ? { duration, position } : { duration }
  );
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType, duration?: number) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  /** Done, and it took something away (delete, unpublish, unlink): red, but not a failure. */
  danger: (message: string) => void;
  warning: (message: string) => void;
}

// Module-level, so the hook returns the same object on every render and every call:
// it is safe in an effect's dependency list and needs no provider.
function make(position?: ToastPosition): ToastContextValue {
  return {
    toast: (message, type, duration) => show(message, type, duration, position),
    success: (message) => show(message, "success", DEFAULT_MS, position),
    error: (message) => show(message, "error", ERROR_MS, position),
    danger: (message) => show(message, "danger", DEFAULT_MS, position),
    warning: (message) => show(message, "warning", DEFAULT_MS, position),
  };
}

const api = make();
const apiTopRight = make("top-right");

export function useToast(position?: ToastPosition): ToastContextValue {
  return position === "top-right" ? apiTopRight : api;
}
