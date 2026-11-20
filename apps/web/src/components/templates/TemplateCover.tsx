import { LayoutTemplateIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { fileHref, type DesignTemplate } from "@/lib/templates";

type Props = { template: Pick<DesignTemplate, "previewUrl" | "category"> & { slideImages?: DesignTemplate["slideImages"] }; className?: string };

/** The preview image of a template (else its first slide), whole and centred in its box; without either, the category on a plain tile. */
export function TemplateCover({ template, className }: Props) {
  const image = template.previewUrl ?? template.slideImages?.[0]?.url ?? null;
  if (image) {
    return (
      <div className={cn("flex items-center justify-center overflow-hidden rounded-xl bg-neutral-50", className)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={fileHref(image)} alt="" loading="lazy" className="size-full object-contain p-3" />
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-xl bg-neutral-50 px-4 text-center", className)}>
      <LayoutTemplateIcon aria-hidden="true" className="size-8 text-neutral-500" />
      <span className="line-clamp-2 type-body-sb-xs text-neutral-800">{template.category}</span>
      <span className="type-body-r-xs text-neutral-500">No preview</span>
    </div>
  );
}
