import { StatusDot } from "@/components/dashboard/StatusDot";

/** A chip with a status dot: "Content: Draft". Shared by the post drawer and the Edit Content page. */
export function StatusChip({ status, label }: { status: Parameters<typeof StatusDot>[0]["status"]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-bg px-2.5 py-1 type-body-sb-xxs text-fg">
      <StatusDot status={status} className="size-1.5" />
      {label}
    </span>
  );
}
