"use client";

import { LockIcon } from "lucide-react";
import { useBootNone } from "@/components/canvas/CanvasBoot";
import { CanvasGate } from "@/components/canvas/CanvasGate";
import { CanvasHome } from "@/components/canvas/CanvasHome";
import { CanvasMessage } from "@/components/canvas/CanvasMessage";
import { MarketingHome } from "@/components/canvas/MarketingHome";
import { usePermissions } from "@/lib/usePermissions";

// The design team opens its saved designs here; Marketing (owner, admin, member) customizes published templates and opens
// its own designs. Anyone else has nothing here. The API enforces all of it; this only chooses what to show. On the first open
// the loader in CanvasBoot covers this page; coming back from another Canvas page the loader is already gone.
export default function CanvasPage() {
  return <CanvasGate>{(isDesigner) => (isDesigner ? <CanvasHome /> : <ForMarketing />)}</CanvasGate>;
}

function ForMarketing() {
  const { canEditContent } = usePermissions();
  return canEditContent ? <MarketingHome /> : <NothingHere />;
}

function NothingHere() {
  useBootNone(); // nothing to load, so the first-open loader can go
  return <CanvasMessage icon={<LockIcon />} title="Canvas isn't available for your role" description="Ask a workspace admin if you should be able to customize designs here." />;
}
