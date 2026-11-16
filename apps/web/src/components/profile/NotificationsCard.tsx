import { CheckCard } from "@/components/profile/CheckCard";
import { ProfileSection } from "@/components/profile/ProfileSection";
import type { NotificationChoice } from "@/lib/profile-mock";

type Props = {
  scope: string;
  choices: NotificationChoice[];
  /** What is on, by id. */
  on: Record<string, boolean>;
  onChange: (id: string, on: boolean) => void;
};

/** Notifications: which things the person wants to hear about. */
export function NotificationsCard({ scope, choices, on, onChange }: Props) {
  return (
    <ProfileSection title="Notifications" note={scope}>
      <ul className="space-y-2">
        {choices.map((choice) => (
          <li key={choice.id}>
            <CheckCard title={choice.title} note={choice.note} checked={on[choice.id] ?? choice.on} onCheckedChange={(next) => onChange(choice.id, next)} />
          </li>
        ))}
      </ul>
    </ProfileSection>
  );
}
