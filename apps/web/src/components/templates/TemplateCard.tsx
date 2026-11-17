import Link from "next/link";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import { platformLabel } from "@/lib/platforms";
import { createdLine, platformsText, sourceLabel, subLine } from "@/lib/template-library";
import type { DesignTemplate } from "@/lib/templates";
import { TemplateCover } from "./TemplateCover";
import { TemplateStatus } from "./TemplateStatus";

type Props = {
  template: DesignTemplate;
  /** The design team: Delete. */
  canManage: boolean;
  /** Who makes posts (Marketing, Admin): Use template. The design team never does. */
  canUse: boolean;
  onDelete: () => void;
  onUse: () => void;
};

/** One template of the library: its preview, status, what it is for, where its design lives and who made it. */
export function TemplateCard({ template: t, canManage, canUse, onDelete, onUse }: Props) {
  const platforms = platformsText(t.platforms);
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-2xl bg-neutral-50/50 p-4">
      <TemplateCover template={t} className="aspect-8/7" />

      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate type-body-sb-s text-neutral-900" title={t.category}>{t.category}</h3>
        <TemplateStatus published={t.published} />
      </div>

      <div className="flex min-w-0 flex-col gap-2 type-body-r-xs text-neutral-500">
        <p className="truncate">{subLine(t)}</p>
        <p className="flex min-w-0 items-center gap-2">
          {platforms ? (
            <>
              <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
                {t.platforms.map((p) => <PlatformIcon key={p} platform={p} size={16} />)}
              </span>
              <span className="truncate" title={t.platforms.map(platformLabel).join(", ")}>{platforms}</span>
            </>
          ) : (
            <span>No platform yet</span>
          )}
        </p>
        <p className="truncate" title={t.linkUrl ?? undefined}>{sourceLabel(t)}</p>
        <p className="truncate">{createdLine(t)}</p>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <Button asChild size="sm" variant="secondary" className="border-neutral-600 bg-transparent text-neutral-600 hover:bg-neutral-50">
          <Link href={`/templates/${t.id}`} aria-label={`View detail of ${t.category}`}>View detail</Link>
        </Button>
        {canManage && (
          <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-600" aria-label={`Delete ${t.category}`} onClick={onDelete}>
            Delete
          </Button>
        )}
        {canUse && (
          <Button size="sm" variant="outline-brand" aria-label={`Use the ${t.category} template`} onClick={onUse}>
            Use template
          </Button>
        )}
      </div>
    </li>
  );
}
