"use client";

import { useEffect, useRef } from "react";
import { ImagePlusIcon, MousePointerClickIcon, RotateCcwIcon } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Textarea } from "@/components/ui/textarea";

/** What the inspector shows for the selected field. */
export type FieldView =
  | { nodeId: string; kind: "text"; name: string; text: string; original: string; changed: boolean; room: number }
  | { nodeId: string; kind: "image"; name: string; changed: boolean };

interface FieldInspectorProps {
  /** The selected editable field, or null (nothing is selected). */
  field: FieldView | null;
  onText(nodeId: string, text: string): void;
  onImage(nodeId: string, file: File): void;
  onReset(nodeId: string): void;
  /** Ends a run of typing, so the next edit is its own undo step. */
  onSeal(): void;
  uploading: boolean;
  /** Changes whenever the text box should take focus (a double-click on a text field). */
  focusSignal: number;
}

/**
 * What Marketing can do with the field they picked: type new text, or replace the image. Nothing else about a layer is
 * offered, because nothing else can be changed (the design team set the rest, and the server refuses anything more).
 */
export function FieldInspector({ field, onText, onImage, onReset, onSeal, uploading, focusSignal }: FieldInspectorProps) {
  const box = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSignal > 0) {
      box.current?.focus();
      box.current?.select();
    }
  }, [focusSignal]);

  if (!field) {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MousePointerClickIcon />
          </EmptyMedia>
          <EmptyTitle>Pick a field</EmptyTitle>
          <EmptyDescription>Select a field in the list, or on the design, to change its text or image.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate type-body-sb-s text-fg">{field.name}</p>
        <Button variant="ghost" size="sm" disabled={!field.changed} onClick={() => onReset(field.nodeId)}>
          <RotateCcwIcon /> Reset
        </Button>
      </div>

      {field.kind === "text" ? (
        <section className="flex flex-col gap-2">
          <h3 className="section-label">Text</h3>
          <Textarea
            key={field.nodeId}
            ref={box}
            value={field.text}
            rows={6}
            maxLength={field.room}
            aria-label={`Text of ${field.name}`}
            onChange={(e) => onText(field.nodeId, e.target.value)}
            onBlur={onSeal}
          />
          {field.changed && <p className="type-body-r-xs text-muted">Original: “{field.original.length > 120 ? `${field.original.slice(0, 120)}…` : field.original}”</p>}
          {/* A known MVP limit: the design team sets the box and the font, and Marketing cannot resize either. */}
          <p className="type-body-r-xs text-muted">Longer text can overflow the original text box. Check the live preview; the design team sets the size and font.</p>
        </section>
      ) : (
        <section className="flex flex-col gap-2">
          <h3 className="section-label">Image</h3>
          <Button variant="secondary" size="sm" className="self-start" disabled={uploading} aria-busy={uploading} onClick={() => file.current?.click()}>
            {uploading ? <Spinner size="sm" label="Uploading image" /> : <ImagePlusIcon />} Replace image
          </Button>
          <input
            ref={file}
            type="file"
            accept="image/png,image/svg+xml,.png,.svg"
            hidden
            onChange={(e) => {
              const picked = e.target.files?.[0];
              e.target.value = ""; // so picking the same file again still fires
              if (picked) onImage(field.nodeId, picked);
            }}
          />
          <p className="type-body-r-xs text-muted">PNG or SVG. The image keeps this layer&apos;s position and size, and its fit, set by the design team.</p>
        </section>
      )}
    </div>
  );
}
