"use client";

import { useMemo } from "react";
import QRCode from "qrcode";
import { qrPath } from "@/lib/qr";

/**
 * A QR code drawn as one SVG path, from the module matrix: nothing is set as HTML, and no colour is written here (the
 * dark squares are the text colour, the quiet zone is the background). Scanners want dark on light, so it always sits on white.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const code = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
    return { size: qr.modules.size, path: qrPath(qr.modules.data, qr.modules.size) };
  }, [value]);
  const QUIET = 3; // modules of white all round: a scanner needs it to find the edge
  const span = code.size + QUIET * 2;
  return (
    <svg role="img" aria-label={label} viewBox={`${-QUIET} ${-QUIET} ${span} ${span}`} shapeRendering="crispEdges" className={className}>
      <rect x={-QUIET} y={-QUIET} width={span} height={span} className="fill-white" />
      <path d={code.path} className="fill-neutral-950" />
    </svg>
  );
}
