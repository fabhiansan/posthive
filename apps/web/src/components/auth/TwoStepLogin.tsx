"use client";

import { useState } from "react";
import { AuthAlert } from "./AuthAlert";
import { AuthHeading } from "./AuthShell";
import { CodeInput } from "./CodeInput";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { loginWithCode, CHALLENGE_EXPIRED } from "../../lib/auth";
import { looksLikeCode } from "../../lib/two-step";

const LINK_BTN = "type-body-sb-xs text-brand-500 hover:text-brand-300";

type Props = {
  /** What POST /auth/login answered once the password was right. */
  challenge: string;
  /** The code was right and the session is open. */
  onDone: () => void | Promise<void>;
  /** Back to the email and password: Back, or a challenge that ran out. `notice` says why, when it ran out. */
  onBack: (notice?: string) => void;
};

/**
 * The second step of logging in, on the dark panel: six digits from the authenticator app, or a recovery code for
 * somebody who has lost their phone. The password was already right; the challenge is good for 5 minutes and 5 tries.
 */
export function TwoStepLogin({ challenge, onDone, onBack }: Props) {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(value: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await loginWithCode(challenge, value);
      await onDone();
    } catch (err) {
      const message = err instanceof Error ? err.message : "That code didn't work. Try again.";
      // the challenge is over (5 wrong codes, or 5 minutes): nothing more can be tried here, the password is asked again
      if (message === CHALLENGE_EXPIRED) return onBack(CHALLENGE_EXPIRED);
      setError(message);
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    setRecovery((r) => !r);
    setCode("");
    setError(null);
  }

  return (
    <>
      <AuthHeading
        title={recovery ? "Use a recovery code" : "Enter your code"}
        subtitle={
          recovery
            ? "Type one of the recovery codes you saved when you turned on two-step verification. Each one works once."
            : "Open your authenticator app and type the 6-digit code it shows for this account."
        }
      />

      {error && <AuthAlert id="code-error">{error}</AuthAlert>}

      {recovery ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (looksLikeCode(code)) void submit(code);
          }}
          className="space-y-6"
        >
          <div>
            <label htmlFor="recovery-code" className="mb-1 block type-body-sb-xs text-neutral-200">Recovery code</label>
            <Input
              id="recovery-code" variant="line" autoFocus autoComplete="off" autoCapitalize="characters" spellCheck={false}
              placeholder="ABCDE-FGHJK"
              value={code} onChange={(e) => setCode(e.target.value)}
              aria-invalid={!!error} aria-describedby={error ? "code-error" : undefined}
            />
          </div>
          <Button type="submit" variant="auth" disabled={busy || !looksLikeCode(code)}>
            {busy ? "Checking…" : "Log in"}
          </Button>
        </form>
      ) : (
        <CodeInput value={code} onChange={setCode} onComplete={(v) => void submit(v)} busy={busy} invalid={!!error} describedBy={error ? "code-error" : undefined} autoFocus />
      )}

      <p className="flex flex-wrap items-center gap-x-2 type-body-r-xs text-neutral-300">
        <button type="button" onClick={switchMode} className={LINK_BTN}>
          {recovery ? "Use the code from my app" : "Use a recovery code"}
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={() => onBack()} className={LINK_BTN}>
          Back to log in
        </button>
      </p>
    </>
  );
}
