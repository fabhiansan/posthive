"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PaletteIcon } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { canvasProblem, createInstance } from "@/lib/canvas";

/**
 * Starts a Marketing design from a published template and opens it in Canvas. The server decides everything (it is only
 * given the template): which revision the design is made from, its name and its owner. When it refuses (the template was
 * unpublished a moment ago, or has no Canvas design) its own message is shown and nothing is created.
 */
export function CustomizeButton({
  template,
  size = "sm",
  variant = "outline-brand",
  label = "Customize in Canvas",
}: {
  template: { id: string; category: string };
  size?: "sm" | "default";
  variant?: "outline-brand" | "default" | "secondary";
  label?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const { instance } = await createInstance(template.id);
      router.push(`/canvas/${instance.id}`); // the page stays disabled until the editor takes over
    } catch (err) {
      toast.error(canvasProblem(err, "The design could not be created. Try again."));
      setBusy(false);
    }
  }

  return (
    <Button size={size} variant={variant} disabled={busy} aria-busy={busy} aria-label={`${label}: ${template.category}`} onClick={() => void start()}>
      {busy ? <Spinner size="sm" label="Creating" /> : <PaletteIcon />}
      {label}
    </Button>
  );
}
