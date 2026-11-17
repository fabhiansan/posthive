import Link from "next/link";
import { Button } from "@/components/ui/button";
import { templatePillars, templatesLine, type ApiDesignDashboard } from "@/lib/designer-dashboard";
import { DesignPanel } from "./DesignPanel";

type Props = { templates: ApiDesignDashboard["templates"] };

/** "Templates by Content Pillar": how many templates each pillar has and how many of them are published to Marketing. */
export function TemplatePillars({ templates }: Props) {
  return (
    <DesignPanel title="Templates by Content Pillar" action={<span className="type-body-r-xs text-neutral-500">Shared with Marketing</span>}>
      {/* the numbers start at the same place on every row: two columns, not a right edge */}
      <dl className="grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-y-4 rounded-xl bg-neutral-50 px-3 py-2.75 type-body-r-xs text-neutral-500">
        {templatePillars(templates).map((row) => (
          <div key={row.pillar} className="col-span-2 grid grid-cols-subgrid">
            <dt className="min-w-0 truncate pr-2">{row.pillar}</dt>
            <dd className="min-w-0 truncate text-neutral-400">{templatesLine(row)}</dd>
          </div>
        ))}
      </dl>
      <Button asChild variant="secondary" className="w-fit rounded-full border-neutral-500 px-3 py-1.5 type-body-m-s text-neutral-400">
        <Link href="/templates">Open Template Library</Link>
      </Button>
    </DesignPanel>
  );
}
