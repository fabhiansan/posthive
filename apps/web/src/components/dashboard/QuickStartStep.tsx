import Link from "next/link";
import { ArrowRightIcon, CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface QuickStart {
  step: number;
  title: string;
  description: string;
  cta: string;
  href: string;
  /** Already done: the card stays (so nobody wonders what it was) with a tick instead of its number and link. */
  done?: boolean;
}

/**
 * One numbered step of the Quick Start banner, on the banner's dark panel: the step number in a
 * yellow circle, a title, a line of help and a link that does it. A step that is done keeps its title
 * and help, with a green tick for the number and "Done" for the link. Colours come from the sidebar
 * tokens (the same olive family), so it needs no colours of its own.
 */
export function QuickStartStep({ step }: { step: QuickStart }) {
  if (step.done) {
    return (
      <li className="flex flex-col gap-1.5 rounded-xl bg-white/4 p-3.5">
        <span aria-hidden="true" className="mb-1 flex size-6 items-center justify-center rounded-full bg-green-500 text-neutral-950">
          <CheckIcon className="size-3.5" strokeWidth={3} />
        </span>
        <h3 className="type-body-sb-s text-white">{step.title}</h3>
        <p className="flex-1 type-body-r-xs text-white/60">{step.description}</p>
        <p className="mt-1 flex h-8 items-center gap-1.5 type-body-sb-xs text-green-400">
          <CheckIcon aria-hidden="true" className="size-3.5" />
          Done
        </p>
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-1.5 rounded-xl bg-white/8 p-3.5">
      <span aria-hidden="true" className="mb-1 flex size-6 items-center justify-center rounded-full bg-brand-500 type-body-sb-xs text-neutral-950">
        {step.step}
      </span>
      <h3 className="type-body-sb-s text-white">{step.title}</h3>
      <p className="flex-1 type-body-r-xs text-white/60">{step.description}</p>
      <Button asChild variant="link" size="sm" className="mt-1 w-fit text-brand-500 hover:text-brand-300">
        <Link href={step.href}>
          {step.cta}
          <ArrowRightIcon />
        </Link>
      </Button>
    </li>
  );
}
