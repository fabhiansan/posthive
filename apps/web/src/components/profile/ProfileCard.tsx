import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/profile/Pill";
import { initialsOf } from "@/lib/dashboard-format";

type Props = {
  name: string;
  email: string;
  avatarUrl?: string | null;
  /** "Marketing Lead · Braga Tech" */
  subtitle: string;
  role: string;
  duty: string;
  onChangePhoto: () => void;
  onRemovePhoto: () => void;
};

/** The person: a big avatar, the name, the job, and the buttons for the photo. */
export function ProfileCard({ name, email, avatarUrl, subtitle, role, duty, onChangePhoto, onRemovePhoto }: Props) {
  return (
    <Card className="items-center gap-0 border-0 px-5 pt-7 pb-5.5 text-center">
      <Avatar className="size-24">
        {avatarUrl && <AvatarImage src={avatarUrl} alt={name} />}
        <AvatarFallback className="bg-brand-500 type-head-sb-3 text-neutral-950">{initialsOf(name)}</AvatarFallback>
      </Avatar>
      <h2 className="mt-2.25 max-w-full truncate type-head-sb-6 text-fg">{name || "Your name"}</h2>
      <p className="mt-2.75 max-w-full truncate type-body-r-xs text-neutral-500">{subtitle}</p>
      <p className="mt-3 max-w-full truncate type-body-r-xs text-brand-800">{email}</p>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        <Pill tone="warm" className="h-6.5 type-body-m-xs">
          {role}
        </Pill>
        <Pill tone="solid" className="h-6.5">
          {duty}
        </Pill>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" variant="secondary" onClick={onChangePhoto} className="border-neutral-400 px-3.25 py-1.5 type-body-m-s text-neutral-400 hover:text-neutral-600">
          Change photo
        </Button>
        <Button type="button" variant="ghost" onClick={onRemovePhoto} className="py-1.5 type-body-m-s text-neutral-400 hover:text-neutral-600">
          Remove
        </Button>
      </div>
      <p className="mt-3 type-body-r-xxs text-neutral-500">JPG or PNG · at least 400 × 400 px · up to 5 MB</p>
    </Card>
  );
}
