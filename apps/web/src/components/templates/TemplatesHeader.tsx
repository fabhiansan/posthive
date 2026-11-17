"use client";

import { Fragment, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { TopbarActions } from "@/components/dashboard/Topbar";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { useAuth } from "@/context/AuthContext";

type Props = {
  /** The path to here; the last one is the page, the ones before it may link back. */
  crumbs: { label: string; href?: string }[];
  title: string;
  /** Next to the title: the status of a template. */
  badge?: ReactNode;
  subtitle?: string;
};

/** The top of the Template Library pages: breadcrumb, title and line on the left, search, date and avatar on the right. */
export function TemplatesHeader({ crumbs, title, badge, subtitle }: Props) {
  const { user } = useAuth();
  const now = useMemo(() => new Date(), []);
  return (
    <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between xl:gap-6">
      <div className="min-w-0">
        <Breadcrumb>
          <BreadcrumbList>
            {crumbs.map((c, i) => (
              <Fragment key={c.label}>
                {i > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem>
                  {i === crumbs.length - 1 ? (
                    <BreadcrumbPage>{c.label}</BreadcrumbPage>
                  ) : c.href ? (
                    <BreadcrumbLink asChild>
                      <Link href={c.href}>{c.label}</Link>
                    </BreadcrumbLink>
                  ) : (
                    c.label
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="type-display-m-6 text-fg">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="mt-1 max-w-4xl type-body-r-s text-fg">{subtitle}</p>}
      </div>
      <TopbarActions fullName={user?.name ?? ""} avatarUrl={user?.avatarUrl} today={now} />
    </header>
  );
}
