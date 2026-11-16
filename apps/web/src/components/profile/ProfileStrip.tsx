import { PlatformIcon } from "@/components/PlatformIcon";
import { Pill } from "@/components/profile/Pill";
import { Card } from "@/components/ui/card";

type Props = {
  /** "Marketing" */
  role: string;
  /** "Approves & publishes" */
  duty: string;
  /** "Pro plan · annual" */
  plan: string;
  /** "Member since 13 Nov 2026 · active now" */
  since: string;
  /** The platforms of the connected accounts, once each. */
  platforms: string[];
};

/** The strip under the title: who this is in the workspace at a glance, and where they post. */
export function ProfileStrip({ role, duty, plan, since, platforms }: Props) {
  return (
    <Card className="flex-row flex-wrap items-center gap-x-2.5 gap-y-2 border-0 px-5 py-4.5">
      <Pill tone="quiet">Role: {role}</Pill>
      <Pill tone="solid">{duty}</Pill>
      <Pill tone="warm">{plan}</Pill>
      <p className="min-w-0 type-body-r-xs text-neutral-500">{since}</p>
      {platforms.length > 0 && (
        <ul aria-label="Connected platforms" className="ml-auto flex items-center gap-2">
          {platforms.map((platform) => (
            <li key={platform}>
              <PlatformIcon platform={platform} size={32} className="rounded-lg" />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
