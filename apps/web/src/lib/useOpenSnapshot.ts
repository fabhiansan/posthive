"use client";

import { useState } from "react";

/**
 * For a dialog whose subject is chosen by the page (`value` is null while the dialog is closed): the subject as it was when
 * the dialog opened, kept while the dialog fades out. Without it the content is gone the moment the page clears the subject, so
 * the panel shrinks to an empty shell while it is still on screen. It also does not change under a dialog that is open: a template
 * that is reloaded after "Unpublish" does not flip its badge to Draft while the dialog is closing.
 */
export function useOpenSnapshot<T>(value: T | null): T | null {
  const open = value !== null;
  const [wasOpen, setWasOpen] = useState(open);
  const [snapshot, setSnapshot] = useState<T | null>(value);
  // adjusting state while rendering (react.dev "you might not need an effect"): the next opening takes the new subject before anything is painted
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSnapshot(value);
  }
  return snapshot;
}
