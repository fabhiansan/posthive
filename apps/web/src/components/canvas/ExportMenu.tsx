"use client";

import { DownloadIcon } from "lucide-react";
import type { ExportOptions } from "posthive-canvas";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/Spinner";

interface ExportMenuProps {
  /** The design's own size, so each choice can show the pixels it makes. */
  width: number;
  height: number;
  busy: boolean;
  onExport(options: ExportOptions): void;
}

const CHOICES: Array<{ format: ExportOptions["format"]; label: string }> = [
  { format: "png", label: "PNG" },
  { format: "jpeg", label: "JPEG" },
];

export function ExportMenu({ width, height, busy, onExport }: ExportMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" disabled={busy} aria-busy={busy}>
          {busy ? <Spinner size="sm" label="Exporting" /> : <DownloadIcon />} <span className="max-sm:sr-only">Export</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {CHOICES.map(({ format, label }, i) => (
          <div key={format}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            {([1, 2] as const).map((multiplier) => (
              <DropdownMenuItem key={multiplier} onSelect={() => onExport({ format, multiplier })}>
                {multiplier === 1 ? "Original size" : "Double size"}
                <span className="ml-auto type-body-r-xs text-muted">{width * multiplier} × {height * multiplier}</span>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
