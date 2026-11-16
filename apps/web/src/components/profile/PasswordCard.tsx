import type { ReactNode } from "react";
import { ProfileSection } from "@/components/profile/ProfileSection";
import { Button } from "@/components/ui/button";
import { PASSWORD_MIN_LENGTH } from "@/lib/passwordRule";

type Props = {
  /** "Last sign-in today, 08:12 WIB · Chrome on macOS"; left out when nothing records it. */
  lastSignIn?: string;
  /** "Last changed 2 months ago"; left out when nothing records it. */
  changed?: string;
  email: string;
  /** "Link expires after 30 minutes · request a new one anytime" */
  linkNote: string;
  /** The second step of signing in; left out when the app has none. */
  twoStep?: { on: boolean; detail: string };
  sendingLink: boolean;
  onChangePassword: () => void;
  onSendLink: () => void;
  onManage: () => void;
};

/** An action in the corner of a row: plain olive text, a button only to the keyboard. */
export function QuietAction({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <Button type="button" variant="ghost" onClick={onClick} disabled={disabled} className="shrink-0 px-0 text-neutral-400 hover:text-neutral-600 sm:px-5">
      {children}
    </Button>
  );
}

function Row({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <li className="flex flex-col items-start justify-between gap-2 rounded-xl border border-neutral-50 px-4 py-2.75 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
      {action}
    </li>
  );
}

/** Password & sign-in: change the password, ask for a reset link, and the second step. */
export function PasswordCard({ lastSignIn, changed, email, linkNote, twoStep, sendingLink, onChangePassword, onSendLink, onManage }: Props) {
  return (
    <ProfileSection title="Password & sign-in" note={lastSignIn}>
      <ul className="space-y-4">
        <Row action={<QuietAction onClick={onChangePassword}>Change password</QuietAction>}>
          <h3 className="type-body-m-s text-fg">Password</h3>
          {changed && <p className="type-body-r-xs text-neutral-500">{changed}</p>}
          <p className="type-body-r-xxs text-brand-800">Use at least {PASSWORD_MIN_LENGTH} characters with a number</p>
        </Row>

        <Row
          action={
            <QuietAction onClick={onSendLink} disabled={sendingLink}>
              {sendingLink ? "Sending…" : "Send reset link"}
            </QuietAction>
          }
        >
          <h3 className="type-body-m-s text-fg">Password recovery</h3>
          <p className="type-body-r-xs break-words text-neutral-500">Forgot your password? We email a reset link to {email}</p>
          <p className="type-body-r-xxs text-brand-800">{linkNote}</p>
        </Row>

        {twoStep && (
          <Row action={<QuietAction onClick={onManage}>Manage</QuietAction>}>
            <h3 className="flex flex-wrap items-center gap-2 type-body-m-s text-fg">
              Two-step verification
              {twoStep.on && (
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1.25 type-body-r-xxs text-green-600">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-green-600" />
                  On
                </span>
              )}
            </h3>
            <p className="type-body-r-xs text-neutral-500">{twoStep.detail}</p>
          </Row>
        )}
      </ul>
    </ProfileSection>
  );
}
