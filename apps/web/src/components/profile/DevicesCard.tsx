import type { ReactNode } from "react";
import { QuietAction } from "@/components/profile/PasswordCard";
import { ProfileSection } from "@/components/profile/ProfileSection";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import type { Device, SignInRecord } from "@/lib/profile-mock";

type Props = {
  devices: Device[];
  signIns: SignInRecord[];
  /** "Last 30 days" */
  range: string;
  onSignOut: (device: Device) => void;
  onSignOutOthers: () => void;
};

/** A soft pill with a dot: "This device", "Successful", "Wrong password". */
function ResultPill({ tone, children, className }: { tone: "good" | "bad"; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 type-body-m-xs whitespace-nowrap",
        className,
        tone === "good" ? "bg-green-100 text-green-800" : "bg-red-50 text-red-700"
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone === "good" ? "bg-green-600" : "bg-red-500")} />
      {children}
    </span>
  );
}

/** Devices & login history: where the account is signed in, and the last sign-in attempts. */
export function DevicesCard({ devices, signIns, range, onSignOut, onSignOutOthers }: Props) {
  return (
    <ProfileSection
      title="Devices & login history"
      className="gap-4"
      action={
        <Button type="button" variant="ghost" onClick={onSignOutOthers} className="h-9 px-2 text-red-600 hover:bg-red-50 hover:text-red-700">
          Sign out of other devices
        </Button>
      }
    >
      <section aria-labelledby="active-devices" className="space-y-4">
        <h3 id="active-devices" className="type-body-m-s text-fg">
          Active devices
        </h3>
        <ul className="space-y-2">
          {devices.map((device) => (
            <li key={device.id} className="flex items-center gap-3 rounded-xl border border-neutral-50 px-3 py-3.25">
              <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-lg border border-brand-100 bg-brand-50 type-body-m-xs text-brand-800">
                {device.tile}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 type-body-m-s text-fg">
                  {device.name}
                  {device.current && <ResultPill tone="good" className="my-px">This device</ResultPill>}
                </p>
                <p className="type-body-r-xs text-neutral-600">
                  {device.place} · {device.seen}
                </p>
              </div>
              {!device.current && <QuietAction onClick={() => onSignOut(device)}>Sign out</QuietAction>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="recent-sign-ins" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 id="recent-sign-ins" className="type-body-m-s text-fg">
            Recent sign-ins
          </h3>
          <p className="type-body-r-xs text-neutral-500">{range}</p>
        </div>
        <div className="overflow-hidden rounded-xl border border-neutral-50">
          <Table className="type-body-r-xs">
            <TableHeader className="bg-brand-50">
              <TableRow className="border-neutral-50 hover:bg-brand-50">
                {["Date & time", "Device", "Location", "Result"].map((heading) => (
                  <TableHead key={heading} className="h-9.5 type-body-m-xs text-neutral-600">
                    {heading}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {signIns.map((record) => (
                <TableRow key={record.id} className="border-neutral-50">
                  <TableCell className="py-2.5 whitespace-nowrap text-fg">{record.when}</TableCell>
                  <TableCell className="py-2.5 whitespace-nowrap text-neutral-600">{record.device}</TableCell>
                  <TableCell className="py-2.5 whitespace-nowrap text-neutral-600">{record.place}</TableCell>
                  <TableCell className="py-2.5">
                    <ResultPill tone={record.failure ? "bad" : "good"}>{record.failure ?? "Successful"}</ResultPill>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <p className="type-body-r-xxs text-brand-800">Don&apos;t recognise a sign-in? Change your password, then sign out of other devices.</p>
    </ProfileSection>
  );
}
