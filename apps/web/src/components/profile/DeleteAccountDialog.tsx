"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FormField } from "@/components/FormField";
import { PasswordInput } from "@/components/PasswordInput";
import { Input } from "@/components/ui/input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
  /** The workspaces this person owns: they are deleted with the account. */
  owned: string[];
  /** An account with a password confirms with it; one without (a social sign-in) types its email. */
  hasPassword: boolean;
  /** Deletes the account. It shows its own error and throws, so this dialog stays open. */
  onDelete: (proof: string) => Promise<void>;
};

/** Delete the account for good: asks for the password, or for the email when there is no password. */
export function DeleteAccountDialog({ open, onOpenChange, email, owned, hasPassword, onDelete }: Props) {
  const [proof, setProof] = useState("");

  const ready = hasPassword ? proof !== "" : proof === email;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setProof("");
        onOpenChange(next);
      }}
      title="Delete your account?"
      description={
        owned.length > 0
          ? `Your profile, sign-in, the posts you created and the accounts you connected are permanently deleted, and so are the workspaces you own, with everything in them: ${owned.join(", ")}. Cancel a paid plan in Billing first: there are no refunds after deletion.`
          : "Your profile, sign-in, the posts you created and the accounts you connected are permanently deleted."
      }
      confirmLabel="Delete forever"
      pendingLabel="Deleting…"
      confirmDisabled={!ready}
      onConfirm={() => onDelete(proof)}
    >
      <FormField label={hasPassword ? "Your password" : `Type ${email} to confirm`}>
        {(c) =>
          hasPassword ? (
            <PasswordInput {...c} autoComplete="current-password" value={proof} onChange={(e) => setProof(e.target.value)} autoFocus />
          ) : (
            <Input {...c} type="email" autoComplete="off" value={proof} onChange={(e) => setProof(e.target.value)} placeholder={email} autoFocus />
          )
        }
      </FormField>
    </ConfirmDialog>
  );
}
