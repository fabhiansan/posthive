"use client";

import { useRef } from "react";
import { CircleIcon, ImagePlusIcon, MinusIcon, MousePointer2Icon, PlusIcon, Redo2Icon, SquareIcon, TypeIcon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/Spinner";

interface ToolbarProps {
  /** The designer's tools. A Marketing design has none of them: leave all four out and only undo/redo and zoom remain. */
  onAdd?(type: "rect" | "ellipse" | "text"): void;
  /** A PNG or SVG the person picked. */
  onImage?(file: File): void;
  uploading?: boolean;
  onDeselect?(): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  /** 1 = 100%. */
  zoom: number;
  onZoomIn(): void;
  onZoomOut(): void;
  onFit(): void;
}

const ADD = [
  { type: "rect", label: "Rectangle", icon: SquareIcon },
  { type: "ellipse", label: "Ellipse", icon: CircleIcon },
  { type: "text", label: "Text", icon: TypeIcon },
] as const;

const Divider = () => <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;

export function Toolbar({ onAdd, onImage, uploading = false, onDeselect, canUndo, canRedo, onUndo, onRedo, zoom, onZoomIn, onZoomOut, onFit }: ToolbarProps) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      {onAdd && onImage && onDeselect && (
        <>
          {/* Select is the standing mode: the other tools add a layer at once, so there is nothing to switch back from. */}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Select"
            aria-pressed
            title="Select (Esc clears the selection)"
            onClick={onDeselect}
            className="bg-brand-100 text-brand-800 hover:bg-brand-100 hover:text-brand-800"
          >
            <MousePointer2Icon />
          </Button>
          {ADD.map(({ type, label, icon: Icon }) => (
            <Button key={type} variant="ghost" size="icon-sm" aria-label={`Add ${label.toLowerCase()}`} title={`Add ${label.toLowerCase()}`} onClick={() => onAdd(type)}>
              <Icon />
            </Button>
          ))}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add image"
            title="Add image (PNG or SVG)"
            disabled={uploading}
            aria-busy={uploading}
            onClick={() => file.current?.click()}
          >
            {uploading ? <Spinner size="sm" label="Uploading image" /> : <ImagePlusIcon />}
          </Button>
          <input
            ref={file}
            type="file"
            accept="image/png,image/svg+xml,.png,.svg"
            hidden
            onChange={(e) => {
              const picked = e.target.files?.[0];
              e.target.value = ""; // so picking the same file again still fires
              if (picked) onImage(picked);
            }}
          />

          <Divider />
        </>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
        <Undo2Icon />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}>
        <Redo2Icon />
      </Button>

      <Divider />
      <Button variant="ghost" size="icon-sm" aria-label="Zoom out" title="Zoom out" onClick={onZoomOut}>
        <MinusIcon />
      </Button>
      <Button variant="ghost" size="sm" title="Fit to screen" onClick={onFit} className="w-14 shrink-0 tabular-nums">
        <span className="sr-only">Zoom, click to fit to screen: </span>
        {Math.round(zoom * 100)}%
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Zoom in" title="Zoom in" onClick={onZoomIn}>
        <PlusIcon />
      </Button>
    </>
  );
}
