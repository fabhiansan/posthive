import type { ReactNode } from "react";
import { QuietAction } from "@/components/profile/PasswordCard";
import { ProfileSection } from "@/components/profile/ProfileSection";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { lastSeenLabel, signInTime, type ApiDevice, type ApiDevices } from "@/lib/profile-security";

type Props = {
  data: ApiDevices | null;
  loading: boolean;
  error: string | null;
  now: Date;
  /** The id of the device being signed out, so its button can say so. */
  signingOut: string | null;
  /** The recent sign-ins cover this many days. */
  days: number;
  onRetry: () => void;
  onSignOut: (device: ApiDevice) => void;
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
export function DevicesCard({ data, loading, error, now, signingOut, days, onRetry, onSignOut, onSignOutOthers }: Props) {
  const devices = data?.devices ?? [];
  const signIns = data?.signIns ?? [];
  // the button has nothing to do when this is the only device
  const hasOthers = devices.some((d) => !d.current);

  return (
    <ProfileSection
      title="Devices & login history"
      className="gap-4"
      action={
        <Button type="button" variant="ghost" onClick={onSignOutOthers} disabled={!hasOthers} className="h-9 px-2 text-red-600 hover:bg-red-50 hover:text-red-700">
          Sign out of other devices
        </Button>
      }
    >
      {!data && loading && (
        <div aria-busy="true" aria-label="Loading your devices" className="space-y-2">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      )}

      {!data && !loading && error && (
        <p role="alert" className="type-body-r-xs text-red-600">
          We couldn&apos;t load your devices.{" "}
          <button type="button" onClick={onRetry} className="underline underline-offset-2">
            Try again
          </button>
        </p>
      )}

      {data && (
        <>
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
                    <p className="type-body-r-xs text-neutral-600">{lastSeenLabel(device.lastActiveAt, device.current, now)}</p>
                  </div>
                  {!device.current && (
                    <QuietAction onClick={() => onSignOut(device)} disabled={signingOut === device.id}>
                      {signingOut === device.id ? "Signing out…" : "Sign out"}
                    </QuietAction>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="recent-sign-ins" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 id="recent-sign-ins" className="type-body-m-s text-fg">
                Recent sign-ins
              </h3>
              <p className="type-body-r-xs text-neutral-500">Last {days} days</p>
            </div>
            {signIns.length === 0 ? (
              <p className="rounded-xl border border-neutral-50 px-4 py-6 text-center type-body-r-xs text-neutral-500">No sign-ins in the last {days} days.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-neutral-50">
                <Table className="type-body-r-xs">
                  <TableHeader className="bg-brand-50">
                    <TableRow className="border-neutral-50 hover:bg-brand-50">
                      {["Date & time", "Device", "Result"].map((heading) => (
                        <TableHead key={heading} className="h-9.5 type-body-m-xs text-neutral-600">
                          {heading}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {signIns.map((record) => (
                      <TableRow key={record.id} className="border-neutral-50">
                        <TableCell className="py-2.5 whitespace-nowrap text-fg">{signInTime(record.at, now)}</TableCell>
                        <TableCell className="py-2.5 whitespace-nowrap text-neutral-600">{record.device}</TableCell>
                        <TableCell className="py-2.5">
                          <ResultPill tone={record.failure ? "bad" : "good"}>{record.failure ?? "Successful"}</ResultPill>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          <p className="type-body-r-xxs text-brand-800">Don&apos;t recognise a sign-in? Change your password, then sign out of other devices.</p>
        </>
      )}
    </ProfileSection>
  );
}
