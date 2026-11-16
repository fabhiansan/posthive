"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/FormField";
import { PasswordInput } from "@/components/PasswordInput";
import { useToast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { PASSWORD_HINT, passwordProblem } from "@/lib/passwordRule";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Change the password: the current one, the new one twice. The server signs out every other device when it changes. */
export function ChangePasswordDialog({ open, onOpenChange }: Props) {
  const { success, error } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Nothing typed here may outlive the dialog.
  function change(nextOpen: boolean) {
    if (pending) return;
    if (!nextOpen) {
      setCurrent("");
      setNext("");
      setAgain("");
      setProblem(null);
    }
    onOpenChange(nextOpen);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found = passwordProblem(next) ?? (next !== again ? "The new passwords don't match" : null);
    setProblem(found);
    if (found) return;
    setPending(true);
    try {
      await apiFetch("/user/password", { method: "PATCH", body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      success("Password changed");
      change(false);
    } catch (err) {
      error(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>You&apos;ll stay signed in here. Your other devices are signed out.</DialogDescription>
          </DialogHeader>
          <FormField label="Current password">
            {(c) => <PasswordInput {...c} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />}
          </FormField>
          <FormField label="New password" hint={PASSWORD_HINT} error={problem}>
            {(c) => <PasswordInput {...c} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
          </FormField>
          <FormField label="Confirm new password">
            {(c) => <PasswordInput {...c} autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => change(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !current || !next || !again}>
              {pending ? "Updating…" : "Update password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
