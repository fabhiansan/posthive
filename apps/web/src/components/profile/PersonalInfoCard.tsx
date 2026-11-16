import { CircleHelpIcon } from "lucide-react";
import { PlatformIcon } from "@/components/PlatformIcon";
import { CheckCard } from "@/components/profile/CheckCard";
import { FIELD_CONTROL, FieldBox, ReadOnlyBox } from "@/components/profile/FieldBox";
import { ProfileSection } from "@/components/profile/ProfileSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { platformLabel } from "@/lib/platforms";
import { NAME_MAX, type Choice } from "@/lib/profile-mock";
import type { ConnectedAccount } from "@/lib/profile";

type Props = {
  name: string;
  onName: (value: string) => void;
  /** The name is empty: it is the one thing that cannot be saved without. */
  nameInvalid: boolean;
  about: string;
  aboutMax: number;
  onAbout: (value: string) => void;
  /** "Marketing" */
  role: string;
  team: string;
  teams: Choice[];
  onTeam: (value: string) => void;
  email: string;
  language: string;
  languages: Choice[];
  onLanguage: (value: string) => void;
  accounts: ConnectedAccount[];
  /** The accounts that are ticked, by id. */
  ticked: Record<string, boolean>;
  onTick: (id: string, on: boolean) => void;
};

/** A drop-down in the same box as the text fields: the label small above the chosen value. */
function ChoiceBox({ label, value, choices, onChange }: { label: string; value: string; choices: Choice[]; onChange: (value: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="h-auto rounded-xl border-neutral-500 py-2">
        <span className="flex min-w-0 flex-col items-start text-left">
          <span className="type-body-r-xxs text-neutral-600">{label}</span>
          <SelectValue className="truncate" />
        </span>
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Personal information: the details people see, the role they cannot change, and the accounts they post to. */
export function PersonalInfoCard({ name, onName, nameInvalid, about, aboutMax, onAbout, role, team, teams, onTeam, email, language, languages, onLanguage, accounts, ticked, onTick }: Props) {
  return (
    <ProfileSection title="Personal information" note="Visible to people in your workspace">
      <p className="rounded-lg bg-red-50 px-3.5 py-2 type-body-r-xs text-neutral-500">
        Your name and photo appear on posts you create, approvals and briefs you send to the Design Team.
      </p>

      <div className="space-y-4">
        <FieldBox label="Full name *" invalid={nameInvalid}>
          <input
            value={name}
            onChange={(e) => onName(e.target.value)}
            required
            maxLength={NAME_MAX}
            autoComplete="name"
            aria-invalid={nameInvalid || undefined}
            className={FIELD_CONTROL}
          />
        </FieldBox>

        <div>
          <FieldBox label="About you">
            <textarea value={about} maxLength={aboutMax} onChange={(e) => onAbout(e.target.value)} className={cn(FIELD_CONTROL, "h-26.5 resize-none")} />
          </FieldBox>
          <p className="mt-1 flex items-center gap-2 type-body-r-xs text-neutral-600" aria-live="polite">
            <CircleHelpIcon aria-hidden="true" className="size-4" />
            {about.length} / {aboutMax} characters
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ReadOnlyBox label="Role · set by admin">{role}</ReadOnlyBox>
          <ChoiceBox label="Team" value={team} choices={teams} onChange={onTeam} />
        </div>

        <FieldBox label="Work email *">
          <input type="email" value={email} readOnly aria-readonly="true" autoComplete="email" className={FIELD_CONTROL} />
        </FieldBox>
        <p className="type-body-r-xxs text-neutral-500">Your work email is used to sign in and to recover your password. Your role is assigned by a workspace admin.</p>

        <ChoiceBox label="Language" value={language} choices={languages} onChange={onLanguage} />

        <div>
          <h3 className="mb-2.5 type-body-m-xs text-neutral-600">Connected accounts</h3>
          {accounts.length === 0 ? (
            <p className="rounded-xl border border-dashed border-neutral-300 px-3 py-3 type-body-r-xs text-neutral-500">No accounts are connected to this workspace yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {accounts.map((account) => (
                <CheckCard
                  key={account.id}
                  title={platformLabel(account.platform)}
                  label={`${platformLabel(account.platform)}, ${account.displayName}`}
                  note={`${account.displayName} · connected`}
                  checked={ticked[account.id] ?? true}
                  onCheckedChange={(on) => onTick(account.id, on)}
                  media={<PlatformIcon platform={account.platform} size={24} className="shrink-0 rounded-full" />}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </ProfileSection>
  );
}
