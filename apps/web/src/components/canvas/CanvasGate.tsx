"use client";

import { CircleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/lib/usePermissions";
import { CanvasMessage, CanvasWaiting } from "./CanvasMessage";
import { useWorkspaceWait } from "./useWorkspaceWait";

/**
 * Waits for the workspace, then says whether the person is on the design team. The role is only the workspace's role
 * once the workspace is there, so nothing is decided before that (the same rule as the review queue). The API
 * enforces everything; this only chooses what to show. Each branch is its own component, so each calls its own hooks.
 */
export function CanvasGate({ children }: { children: (isDesigner: boolean) => React.ReactNode }) {
  const { status, retry } = useWorkspaceWait();
  const { canManageTemplates } = usePermissions(); // true only for the designer role
  if (status === "timeout") {
    return (
      <CanvasMessage icon={<CircleAlertIcon />} title="Your workspace didn't load" description="Check your connection and try again.">
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      </CanvasMessage>
    );
  }
  if (status !== "ready") return <CanvasWaiting />;
  return <>{children(canManageTemplates)}</>;
}
