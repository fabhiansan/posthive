"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TopbarActions } from "@/components/dashboard/Topbar";
import { ImportActionBar } from "@/components/import/ImportActionBar";
import { AccountCard } from "@/components/profile/AccountCard";
import { ActivityCard } from "@/components/profile/ActivityCard";
import { ChangePasswordDialog } from "@/components/profile/ChangePasswordDialog";
import { DeleteAccountDialog } from "@/components/profile/DeleteAccountDialog";
import { DevicesCard } from "@/components/profile/DevicesCard";
import { NotificationsCard } from "@/components/profile/NotificationsCard";
import { PasswordCard } from "@/components/profile/PasswordCard";
import { PersonalInfoCard } from "@/components/profile/PersonalInfoCard";
import { ProfileCard } from "@/components/profile/ProfileCard";
import { ProfileStrip } from "@/components/profile/ProfileStrip";
import { RolePermissionsCard } from "@/components/profile/RolePermissionsCard";
import { useToast } from "@/components/Toast";
import { TrialUrgentBanner } from "@/components/TrialUrgentBanner";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";
import { useWorkspace } from "@/context/WorkspaceContext";
import { apiFetch } from "@/lib/api";
import { BRAND } from "@/lib/brand";
import { platformLabel } from "@/lib/platforms";
import { memberSince, planLine, quarterOf, type ConnectedAccount } from "@/lib/profile";
import {
  ABOUT_MAX,
  ACTIVITY,
  DEVICES,
  LANGUAGE,
  LANGUAGES,
  NOTIFICATIONS,
  NOTIFICATIONS_SCOPE,
  PLAN_INTERVAL,
  SIGN_INS,
  SIGN_INS_RANGE,
  SIGN_IN,
  WORKS_WITH_CONTACT,
  sampleOf,
  sampleOn,
} from "@/lib/profile-mock";
import { roleProfileOf } from "@/lib/role-profile";
import type { AppRole } from "@/lib/permissions";

const NOT_YET = "Not available yet";

/** What the form holds that the server does not keep yet: it starts as the mock and goes back to it on Cancel. */
interface Draft {
  name: string;
  about: string;
  team: string;
  language: string;
  notifications: Record<string, boolean>;
  accounts: Record<string, boolean>;
}

/**
 * My Profile: the person's own page. Their name is saved for real; the rest of the form, the devices
 * and the activity come from lib/profile-mock.ts until the API has them. What the role may do is
 * read from lib/role-profile.ts, so another role changes data, not markup.
 */
export default function ProfilePage() {
  const router = useRouter();
  const { user, refresh, logout } = useAuth();
  const { activeWorkspace, workspaces } = useWorkspace();
  const { toast, success, error } = useToast();
  const now = useMemo(() => new Date(), []);

  const role = activeWorkspace?.role ?? user?.role ?? null;
  const profile = roleProfileOf(role);
  const sample = sampleOf(role);
  // Without the sample, only what the app really knows is shown (see sampleOn)
  const demo = sampleOn();
  const owned = workspaces.filter((w) => w.role === "owner").map((w) => w.name);
  const workspaceName = activeWorkspace?.name ?? "";
  const email = user?.email ?? "";
  const quarter = quarterOf(now);

  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  useEffect(() => {
    let current = true;
    apiFetch<ConnectedAccount[]>("/accounts")
      .then((rows) => current && setAccounts(Array.isArray(rows) ? rows : []))
      .catch(() => current && setAccounts([]));
    return () => {
      current = false;
    };
  }, []);

  // The values the form starts from, and returns to on Cancel. Saving makes the saved draft the new start.
  const [saved, setSaved] = useState<Draft>({
    name: "",
    about: demo ? sample.about : "",
    team: sample.teams[0].value,
    language: LANGUAGE,
    notifications: Object.fromEntries(NOTIFICATIONS.map((n) => [n.id, n.on])),
    accounts: {},
  });
  const [draft, setDraft] = useState<Draft>(saved);
  const [named, setNamed] = useState(false);
  const [nameInvalid, setNameInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [sendingLink, setSendingLink] = useState(false);

  // The name comes with the session, which may arrive after the first render: take it once, unless typing has begun.
  useEffect(() => {
    if (!user || named) return;
    setSaved((s) => ({ ...s, name: user.name }));
    setDraft((d) => ({ ...d, name: user.name }));
    setNamed(true);
  }, [user, named]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  function cancel() {
    setDraft(saved);
    setNameInvalid(false);
  }

  async function save() {
    if (!dirty) {
      toast("No changes to save");
      return;
    }
    const name = draft.name.trim();
    if (!name) {
      setNameInvalid(true);
      error("Enter your full name");
      return;
    }
    setSaving(true);
    try {
      const nameChanged = name !== saved.name;
      // Only the name has a server behind it: say so, so nobody believes the rest was stored
      const keptHereOnly = JSON.stringify({ ...draft, name: "" }) !== JSON.stringify({ ...saved, name: "" });
      if (nameChanged) {
        await apiFetch("/user/profile", { method: "PATCH", body: JSON.stringify({ name }) });
        await refresh();
      }
      const next = { ...draft, name };
      setSaved(next);
      setDraft(next);
      setNameInvalid(false);
      success(nameChanged ? (keptHereOnly ? "Name saved. Your other changes stay on this page for now" : "Name saved") : "Saved on this page only for now");
    } catch (e) {
      error(e instanceof Error ? e.message : "Failed to save your changes");
    } finally {
      setSaving(false);
    }
  }

  async function sendResetLink() {
    if (!email) return;
    setSendingLink(true);
    try {
      await apiFetch("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
      success(`We sent a reset link to ${email}`);
    } catch (e) {
      error(e instanceof Error ? e.message : "Failed to send the reset link");
    } finally {
      setSendingLink(false);
    }
  }

  function changePassword() {
    if (user?.hasPassword) setPasswordOpen(true);
    else toast("Your account signs in without a password. Use Send reset link to set one.");
  }

  async function logOut() {
    await logout();
    router.replace("/login");
  }

  async function deleteAccount(proof: string) {
    try {
      await apiFetch("/user", { method: "DELETE", body: JSON.stringify({ password: proof }) });
    } catch (e) {
      error(e instanceof Error ? e.message : "Failed to delete your account");
      throw e;
    }
    await logout();
    router.replace("/login");
  }

  const team = sample.teams.find((t) => t.value === draft.team) ?? sample.teams[0];
  const contact = demo ? WORKS_WITH_CONTACT[role as AppRole] : undefined;
  const platforms = [...new Set(accounts.filter((a) => draft.accounts[a.id] ?? true).map((a) => a.platform))];
  const since = memberSince(activeWorkspace?.joinedAt ?? activeWorkspace?.createdAt);

  return (
    <div className="theme-dashboard flex-1 overflow-y-auto bg-background">
      <TrialUrgentBanner />
      <div className="mx-auto flex max-w-[110rem] flex-col gap-4 p-4 pt-16 md:p-6 md:pt-6">
        <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between xl:gap-6">
          <div className="min-w-0">
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>Setting &amp; Integration</BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>My profile</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <h1 className="mt-3 type-display-m-6 text-fg">My Profile</h1>
            <p className="mt-1 max-w-3xl type-body-r-l text-brand-950">Your photo, personal details, role, sign-in security and the devices signed in to your account.</p>
          </div>
          <TopbarActions fullName={user?.name ?? ""} avatarUrl={user?.avatarUrl} today={now} />
        </header>

        <ProfileStrip
          role={profile.label}
          duty={profile.duty}
          plan={planLine(activeWorkspace?.plan, demo ? PLAN_INTERVAL : undefined)}
          since={`${since ? `Member since ${since} · ` : ""}active now`}
          platforms={platforms}
        />

        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_--spacing(105)]">
          <div className="flex min-w-0 flex-col gap-4">
            <PersonalInfoCard
              name={draft.name}
              onName={(name) => {
                setNameInvalid(false);
                set({ name });
              }}
              nameInvalid={nameInvalid}
              about={draft.about}
              aboutMax={ABOUT_MAX}
              onAbout={(about) => set({ about })}
              role={profile.label}
              team={draft.team}
              teams={sample.teams}
              onTeam={(value) => set({ team: value })}
              email={email}
              language={draft.language}
              languages={LANGUAGES}
              onLanguage={(language) => set({ language })}
              accounts={accounts}
              ticked={draft.accounts}
              onTick={(id, on) => set({ accounts: { ...draft.accounts, [id]: on } })}
            />
            <NotificationsCard
              scope={NOTIFICATIONS_SCOPE}
              choices={NOTIFICATIONS}
              on={draft.notifications}
              onChange={(id, on) => set({ notifications: { ...draft.notifications, [id]: on } })}
            />
            <PasswordCard
              lastSignIn={demo ? SIGN_IN.lastSignIn : undefined}
              changed={demo ? SIGN_IN.passwordChanged : undefined}
              email={email}
              linkNote={SIGN_IN.linkExpires}
              twoStep={demo ? SIGN_IN.twoStep : undefined}
              sendingLink={sendingLink}
              onChangePassword={changePassword}
              onSendLink={() => void sendResetLink()}
              onManage={() => toast(NOT_YET)}
            />
            {demo && <DevicesCard devices={DEVICES} signIns={SIGN_INS} range={SIGN_INS_RANGE} onSignOut={() => toast(NOT_YET)} onSignOutOthers={() => toast(NOT_YET)} />}
            <AccountCard
              email={email}
              workspace={workspaceName}
              owned={owned}
              hasPassword={Boolean(user?.hasPassword)}
              onLogout={() => void logOut()}
              onDelete={() => setDeleteOpen(true)}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <ProfileCard
              name={draft.name}
              email={email}
              avatarUrl={user?.avatarUrl}
              subtitle={[demo ? sample.jobTitle : profile.label, workspaceName].filter(Boolean).join(" · ")}
              role={profile.label}
              duty={profile.duty}
              onChangePhoto={() => toast(NOT_YET)}
              onRemovePhoto={() => toast(NOT_YET)}
            />
            <RolePermissionsCard
              profile={profile}
              team={[team.team, workspaceName].filter(Boolean).join(" · ")}
              worksWith={contact ? `${profile.worksWith} · ${contact}` : profile.worksWith}
            />
            {demo && <ActivityCard quarter={quarter.label} resets={quarter.resets} counts={ACTIVITY} />}
          </div>
        </div>

        <ImportActionBar className="py-3.75" status={<span className="text-neutral-600">Changes to your name, photo and notifications apply across {BRAND.name} Studio.</span>}>
          <Button type="button" variant="secondary" onClick={cancel} disabled={saving} className="border-neutral-400 py-1.5 text-neutral-400 hover:text-neutral-600">
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving} className="py-1.5">
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </ImportActionBar>
      </div>

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
      <DeleteAccountDialog open={deleteOpen} onOpenChange={setDeleteOpen} email={email} owned={owned} hasPassword={Boolean(user?.hasPassword)} onDelete={deleteAccount} />
    </div>
  );
}
