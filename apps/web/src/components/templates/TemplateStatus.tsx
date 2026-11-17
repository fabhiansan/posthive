import { CheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

type Props = { published: boolean; className?: string };

/** The status of a template: a yellow Published, or an outlined Draft with a grey dot. */
export function TemplateStatus({ published, className }: Props) {
  return published ? (
    <Badge className={cn("border-brand-500 bg-brand-500 text-brand-950", className)}>
      <CheckIcon aria-hidden="true" />
      Published
    </Badge>
  ) : (
    <Badge variant="outline" className={cn("border-brand-600 text-neutral-800", className)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-neutral-400" />
      Draft
    </Badge>
  );
}
