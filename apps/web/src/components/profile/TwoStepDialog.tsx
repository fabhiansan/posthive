"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/FormField";
import { PasswordInput } from "@/components/PasswordInput";
import { CodeInput } from "@/components/auth/CodeInput";
import { QrCode } from "@/components/profile/QrCode";
import { useToast } from "@/components/Toast";
import { apiFetch } from "@/lib/api";
import { BRAND } from "@/lib/brand";
import { groupedKey, looksLikeCode, recoveryCodesFile, type ApiTwoStep } from "@/lib/two-step";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether it is on now: off starts setup, on opens Manage. */
  enabled: boolean;
  email: string;
  /** It was turned on or off, or the codes were made again: the row on the page reads the state again. */
  onChanged: () => void;
  recoveryLeft?: ApiTwoStep["recoveryLeft"];
};

/** "scan": the QR code and the first code. "codes": the recovery codes, shown once. "manage": it is on. The last two need the password and a code. */
type View = "scan" | "codes" | "manage" | "turn-off" | "new-codes";

const COPIED_MS = 2000;

/**
 * Two-step verification with an authenticator app. Turning it on is: scan, type the first code, save the recovery codes.
 * Turning it off and making new recovery codes ask for the password AND a code, so a stolen session cannot do either.
 */
export function TwoStepDialog({ open, onOpenChange, enabled, email, onChanged, recoveryLeft = 0 }: Props) {
  const { success, error } = useToast();
  const [view, setView] = useState<View>("scan");
  const [setup, setSetup] = useState<{ setupKey: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<"key" | "codes" | null>(null);
  const started = useRef(false);

  function reset() {
    setSetup(null);
    setCode("");
    setPassword("");
    setProblem(null);
    setPending(false);
    setCodes([]);
    setSaved(false);
    setCopied(null);
    started.current = false;
  }

  // Opening: off starts a fresh secret; on shows Manage. Nothing typed or made here outlives the dialog.
  // This runs when the dialog OPENS, not when `enabled` changes: turning it on makes the page read the state again, `enabled`
  // flips to true while the recovery codes are on screen, and reacting to that would swap them for "Manage" before they are saved.
  const enabledOnOpen = useRef(enabled);
  enabledOnOpen.current = enabled;
  useEffect(() => {
    if (!open) return;
    const on = enabledOnOpen.current;
    setView(on ? "manage" : "scan");
    if (on || started.current) return;
    started.current = true;
    apiFetch<{ setupKey: string; otpauthUrl: string }>("/user/two-step/start", { method: "POST", body: JSON.stringify({}) })
      .then(setSetup)
      .catch((e) => {
        setProblem(e instanceof Error ? e.message : "We couldn't start setup. Try again.");
        started.current = false;
      });
  }, [open]);

  // The recovery codes are shown once. Closing before they are saved would lose them, so it asks the person to tick first.
  const mustSave = view === "codes" && !saved;
  function change(next: boolean) {
    if (pending) return;
    if (!next && mustSave) {
      setProblem("Save your recovery codes first, then tick the box. You won't see them again.");
      return;
    }
    if (!next) reset();
    onOpenChange(next);
  }

  async function copy(text: string, what: "key" | "codes") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), COPIED_MS);
    } catch {
      error("We couldn't copy that. Select it and copy it yourself.");
    }
  }

  function download() {
    const blob = new Blob([recoveryCodesFile(codes, BRAND.name, email, new Date())], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${BRAND.name.toLowerCase()}-recovery-codes.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function enable(value: string) {
    if (pending || !setup) return;
    setPending(true);
    setProblem(null);
    try {
      const done = await apiFetch<{ recoveryCodes: string[] }>("/user/two-step/enable", { method: "POST", body: JSON.stringify({ password, code: value }) });
      setCodes(done.recoveryCodes);
      setSaved(false);
      setPassword("");
      setView("codes");
      onChanged();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That code didn't work. Try again.");
      setCode("");
    } finally {
      setPending(false);
    }
  }

  /** Turn off, or make new recovery codes: the password and a code, both. */
  async function confirm(kind: "turn-off" | "new-codes", e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setProblem(null);
    try {
      const body = JSON.stringify({ password, code: code.trim() });
      if (kind === "turn-off") {
        await apiFetch("/user/two-step/disable", { method: "POST", body });
        success("Two-step verification is off");
        onChanged();
        reset();
        onOpenChange(false);
      } else {
        const done = await apiFetch<{ recoveryCodes: string[] }>("/user/two-step/recovery-codes", { method: "POST", body });
        setCodes(done.recoveryCodes);
        setSaved(false);
        setCode("");
        setPassword("");
        setView("codes");
        onChanged();
      }
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "That didn't work. Try again.");
      setCode("");
    } finally {
      setPending(false);
    }
  }

  const title = { scan: "Turn on two-step verification", codes: "Save your recovery codes", manage: "Two-step verification", "turn-off": "Turn off two-step verification", "new-codes": "Make new recovery codes" }[view];

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-md" onInteractOutside={(e) => mustSave && e.preventDefault()} onEscapeKeyDown={(e) => mustSave && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {view === "scan" && "Scan the code with an authenticator app (Google Authenticator, Authy or 1Password), then type the 6 digits it shows."}
            {view === "codes" && "If you lose your phone, each of these codes lets you sign in once. They are shown only now."}
            {view === "manage" && "A code from your authenticator app is asked for each time you sign in."}
            {view === "turn-off" && "Anyone with your password could then sign in without a code."}
            {view === "new-codes" && "The codes you have now stop working."}
          </DialogDescription>
        </DialogHeader>

        {problem && (
          <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 type-body-r-xs text-red-600">
            {problem}
          </p>
        )}

        {view === "scan" && (
          <div className="grid gap-4">
            {setup ? (
              <>
                <div className="mx-auto w-48 overflow-hidden rounded-xl border border-border">
                  <QrCode value={setup.otpauthUrl} label="QR code to scan with your authenticator app" className="block h-auto w-full" />
                </div>
                <div className="grid gap-1.5">
                  <p className="type-body-r-xs text-neutral-500">Can&apos;t scan? Type this key into your app instead.</p>
                  <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2">
                    <code className="min-w-0 flex-1 break-all type-mono-r-s text-fg">{groupedKey(setup.setupKey)}</code>
                    <Button type="button" variant="ghost" size="sm" onClick={() => void copy(setup.setupKey, "key")} aria-label="Copy the key">
                      {copied === "key" ? <CheckIcon /> : <CopyIcon />}
                      {copied === "key" ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
                <FormField label="Your password" hint="Asked so that nobody else can add their own phone to your account.">
                  {(c) => <PasswordInput {...c} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
                </FormField>
                <div className="grid gap-2">
                  <p className="type-body-sb-s text-fg">Then type the code it shows</p>
                  {/* the code is only sent once the password is there: six digits typed first wait for it */}
                  <CodeInput light value={code} onChange={setCode} onComplete={(v) => (password ? void enable(v) : setProblem("Type your password first."))} busy={pending} invalid={!!problem} />
                </div>
              </>
            ) : (
              !problem && <p className="type-body-r-s text-neutral-500">Making your code…</p>
            )}
          </div>
        )}

        {view === "codes" && (
          <div className="grid gap-4">
            <ul className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface p-3" aria-label="Recovery codes">
              {codes.map((c) => (
                <li key={c} className="type-mono-r-s text-fg">{c}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => void copy(codes.join("\n"), "codes")}>
                {copied === "codes" ? <CheckIcon /> : <CopyIcon />}
                {copied === "codes" ? "Copied" : "Copy all"}
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={download}>
                <DownloadIcon />
                Download
              </Button>
            </div>
            <label className="flex cursor-pointer items-start gap-2 type-body-r-s text-fg">
              <Checkbox checked={saved} onCheckedChange={(v) => { setSaved(v === true); setProblem(null); }} aria-label="I saved these codes" className="mt-0.5" />
              I saved these codes somewhere safe
            </label>
          </div>
        )}

        {view === "manage" && (
          <div className="grid gap-3">
            <p className="rounded-xl border border-border bg-surface px-3 py-2 type-body-r-s text-fg">
              {recoveryLeft === 1 ? "1 recovery code left." : `${recoveryLeft} recovery codes left.`}
            </p>
          </div>
        )}

        {(view === "turn-off" || view === "new-codes") && (
          <form onSubmit={(e) => void confirm(view, e)} id="two-step-confirm" className="grid gap-4">
            <FormField label="Your password">
              {(c) => <PasswordInput {...c} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
            </FormField>
            <FormField label="Code from your app, or a recovery code" hint="6 digits, or a recovery code like ABCDE-FGHJK.">
              {(c) => <Input {...c} autoComplete="one-time-code" inputMode="text" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />}
            </FormField>
          </form>
        )}

        <DialogFooter>
          {view === "scan" && (
            <Button type="button" variant="secondary" disabled={pending} onClick={() => change(false)}>
              Cancel
            </Button>
          )}
          {view === "codes" && (
            <Button type="button" disabled={!saved} onClick={() => change(false)}>
              Done
            </Button>
          )}
          {view === "manage" && (
            <>
              <Button type="button" variant="secondary" onClick={() => { setProblem(null); setView("new-codes"); }}>
                New recovery codes
              </Button>
              <Button type="button" variant="destructive" onClick={() => { setProblem(null); setView("turn-off"); }}>
                Turn off
              </Button>
            </>
          )}
          {(view === "turn-off" || view === "new-codes") && (
            <>
              <Button type="button" variant="secondary" disabled={pending} onClick={() => { setProblem(null); setCode(""); setPassword(""); setView("manage"); }}>
                Back
              </Button>
              <Button type="submit" form="two-step-confirm" variant={view === "turn-off" ? "destructive" : "default"} disabled={pending || !password || !looksLikeCode(code)}>
                {pending ? "Checking…" : view === "turn-off" ? "Turn off" : "Make new codes"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
