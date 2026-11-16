import { ProfileSection } from "@/components/profile/ProfileSection";
import type { RoleProfile } from "@/lib/role-profile";

type Props = {
  profile: RoleProfile;
  /** "Marketing · Braga Tech" */
  team: string;
  /** "Design Team · Dewi W." */
  worksWith: string;
};

/** Role & permissions: what the role is, with whom the person works, and what it allows. All of it comes from the role's profile. */
export function RolePermissionsCard({ profile, team, worksWith }: Props) {
  const rows: [string, string][] = [
    ["Role", profile.label],
    ["Team", team],
    ["Works with", worksWith],
    ["Can", profile.can],
    ["Can't", profile.cannot],
  ];
  return (
    <ProfileSection title="Role & permissions" note="Set by a workspace admin" className="pt-4.5">
      <dl className="space-y-4 rounded-xl bg-red-50 px-3 py-3">
        {rows.map(([term, detail]) => (
          <div key={term} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
            <dt className="type-body-r-xs text-neutral-500">{term}</dt>
            <dd className="type-body-m-xs text-fg">{detail}</dd>
          </div>
        ))}
      </dl>
      <p className="type-body-r-xxs text-neutral-500">Need different access? Ask a workspace admin to change your role.</p>
    </ProfileSection>
  );
}
