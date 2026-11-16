import { ProfileSection } from "@/components/profile/ProfileSection";
import { Button } from "@/components/ui/button";
import { BRAND } from "@/lib/brand";

type Props = {
  email: string;
  /** The name of the workspace whose other posts stay when this account goes. */
  workspace: string;
  /** The workspaces this person owns: deleting the account deletes each of them with everything in it. */
  owned: string[];
  /** Deleting asks for the password, or for the email when the account has no password. */
  hasPassword: boolean;
  onLogout: () => void;
  onDelete: () => void;
};

/** Account: leave this device, or leave for good. */
export function AccountCard({ email, workspace, owned, hasPassword, onLogout, onDelete }: Props) {
  return (
    <ProfileSection title="Account" note={`Signed in as ${email}`}>
      <div className="space-y-4">
        <div className="flex flex-col items-start justify-between gap-3 rounded-xl border border-neutral-50 px-4 py-3.25 sm:flex-row sm:items-center sm:gap-4">
          <div className="min-w-0">
            <h3 className="type-body-m-s text-fg">Log out</h3>
            <p className="type-body-r-xs text-neutral-600">Sign out of {BRAND.name} on this device. You&apos;ll need your email and password to sign back in.</p>
          </div>
          <Button type="button" variant="secondary" onClick={onLogout} className="shrink-0 border-neutral-400 py-1.5 text-neutral-400 hover:text-neutral-600">
            Log out
          </Button>
        </div>

        <div className="flex flex-col items-start justify-between gap-2 rounded-xl border border-red-100 bg-red-50 px-4 py-4 sm:flex-row sm:items-center sm:gap-4">
          <div className="min-w-0">
            <h3 className="type-body-m-s text-red-700">Delete account</h3>
            <p className="mt-0.5 type-body-r-xs text-neutral-600">
              {owned.length > 0
                ? `Permanently removes your profile, sign-in, the posts you created, the accounts you connected and the workspaces you own (${owned.join(", ")}) with everything in them.`
                : `Permanently removes your profile, sign-in, the posts you created and the accounts you connected. Other people's posts and plans stay in ${workspace ? `the ${workspace} workspace` : "your workspace"}.`}
            </p>
            <p className="mt-1 type-body-r-xxs text-red-600">This can&apos;t be undone. You&apos;ll confirm with your {hasPassword ? "password" : "email"} first.</p>
          </div>
          <Button type="button" variant="ghost" onClick={onDelete} className="shrink-0 px-0 text-red-600 hover:bg-red-100 hover:text-red-700 sm:px-5">
            Delete account
          </Button>
        </div>
      </div>
    </ProfileSection>
  );
}
