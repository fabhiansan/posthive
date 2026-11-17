"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MousePointerClickIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import type { CanvasDocument, CanvasNode, Limits, NodePatch, TextNode } from "posthive-canvas";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

interface InspectorProps {
  doc: CanvasDocument;
  selected: CanvasNode | undefined;
  /**
   * Changes the selected layer. Edits that share a `key` (typing, dragging a colour) undo as one step;
   * onSeal ends that run (a field lost focus).
   */
  onPatch(patch: NodePatch, key: string): void;
  onBackground(color: string): void;
  onSeal(): void;
  onDelete(): void;
  /** Changes whenever the text box should take focus (a double-click on a text layer). */
  focusTextSignal: number;
  /** The font names the editor can draw. */
  fonts: readonly string[];
  /** Every field's range. The engine holds the same numbers to every edit; they are read here, never repeated. */
  limits: Limits;
  /** How long the selected text layer's text may be (engine textRoom): what it holds plus what is left of the design's budget. */
  textRoom: number;
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  onChange,
  onSeal,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange(value: number): void;
  onSeal(): void;
}) {
  const id = useId();
  // The text being typed may not be a number yet ("", "-", "1."), so it is kept apart from the layer's value.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={draft ?? String(Math.round(value * 100) / 100)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="h-8 rounded-lg px-2 py-0"
        onChange={(e) => {
          setDraft(e.target.value);
          const n = e.target.valueAsNumber;
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        onBlur={() => {
          setDraft(null);
          onSeal();
        }}
      />
    </div>
  );
}

function ColorField({ label, value, onChange, onSeal }: { label: string; value: string; onChange(value: string): void; onSeal(): void }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex h-8 items-center gap-2 rounded-lg border border-border bg-bg px-2">
        {/* The browser's own colour picker: it returns #rrggbb, which is what the document stores. */}
        <input
          id={id}
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          onBlur={onSeal}
          className="size-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
        />
        <span className="truncate type-mono-r-xs text-muted">{value}</span>
      </div>
    </div>
  );
}

export function Inspector({ doc, selected, onPatch, onBackground, onSeal, onDelete, focusTextSignal, fonts, limits, textRoom }: InspectorProps) {
  const textBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusTextSignal > 0) {
      textBox.current?.focus();
      textBox.current?.select();
    }
  }, [focusTextSignal]);

  if (!selected) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-b border-border px-4 py-3 type-body-r-s">
          <dt className="text-muted">Canvas size</dt>
          <dd className="text-right text-fg">{doc.width} × {doc.height} px</dd>
        </dl>
        <div className="border-b border-border p-4">
          <ColorField label="Background" value={doc.background.color} onChange={onBackground} onSeal={onSeal} />
        </div>
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MousePointerClickIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing selected</EmptyTitle>
            <EmptyDescription>Select a layer to change its position, size and style.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const n = selected;
  const key = (field: string) => `${n.id}:${field}`;
  const num = (field: keyof NodePatch, value: number, range: { min: number; max: number }, extra: { label: string; step?: number }) => (
    <NumberField
      label={extra.label}
      value={value}
      min={range.min}
      max={range.max}
      step={extra.step}
      onChange={(v) => onPatch({ [field]: v } as NodePatch, key(field))}
      onSeal={onSeal}
    />
  );
  const text = n.type === "text" ? (n as TextNode) : null;
  const hasFill = n.type === "rect" || n.type === "ellipse" || n.type === "text";
  const hasStroke = n.type === "rect" || n.type === "ellipse";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate type-body-sb-s text-fg">{n.name}</p>
        <Button variant="ghost" size="icon-sm" aria-label="Delete layer" onClick={onDelete}>
          <Trash2Icon />
        </Button>
      </div>

      {text && (
        <section className="flex flex-col gap-2">
          <h3 className="section-label">Text</h3>
          <Textarea
            ref={textBox}
            value={text.text}
            rows={4}
            maxLength={textRoom}
            aria-label="Text"
            onChange={(e) => onPatch({ text: e.target.value }, key("text"))}
            onBlur={onSeal}
          />
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label>Font</Label>
              <NativeSelect size="sm" aria-label="Font" value={text.fontFamily} onChange={(e) => onPatch({ fontFamily: e.target.value }, key("font"))} onBlur={onSeal}>
                {fonts.map((f) => (
                  <NativeSelectOption key={f} value={f}>{f}</NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Weight</Label>
              <NativeSelect size="sm" aria-label="Weight" value={text.fontStyle} onChange={(e) => onPatch({ fontStyle: e.target.value }, key("weight"))} onBlur={onSeal}>
                <NativeSelectOption value="400">Regular</NativeSelectOption>
                <NativeSelectOption value="600">Semibold</NativeSelectOption>
              </NativeSelect>
            </div>
            {num("fontSize", text.fontSize, limits.text.fontSize, { label: "Size" })}
            <div className="flex flex-col gap-1">
              <Label>Align</Label>
              <NativeSelect size="sm" aria-label="Align" value={text.align} onChange={(e) => onPatch({ align: e.target.value as TextNode["align"] }, key("align"))} onBlur={onSeal}>
                <NativeSelectOption value="left">Left</NativeSelectOption>
                <NativeSelectOption value="center">Center</NativeSelectOption>
                <NativeSelectOption value="right">Right</NativeSelectOption>
              </NativeSelect>
            </div>
            {num("lineHeight", text.lineHeight, limits.text.lineHeight, { label: "Line height", step: 0.1 })}
            {num("letterSpacing", text.letterSpacing, limits.text.letterSpacing, { label: "Letter spacing" })}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="section-label">Position and size</h3>
        <div className="grid grid-cols-2 gap-2">
          {num("x", n.x, limits.position, { label: "X" })}
          {num("y", n.y, limits.position, { label: "Y" })}
          {num("width", n.width, limits.size, { label: "Width" })}
          {/* A text layer's height follows its text, so it is not a setting. */}
          {text ? null : num("height", n.height, limits.size, { label: "Height" })}
          {num("rotation", n.rotation, limits.rotation, { label: "Rotation" })}
          <NumberField
            label="Opacity %"
            value={n.opacity * 100}
            min={limits.opacity.min * 100}
            max={limits.opacity.max * 100}
            onChange={(v) => onPatch({ opacity: Math.round(v) / 100 }, key("opacity"))}
            onSeal={onSeal}
          />
        </div>
      </section>

      {(hasFill || hasStroke) && (
        <section className="flex flex-col gap-2">
          <h3 className="section-label">Style</h3>
          {hasFill && <ColorField label={text ? "Text colour" : "Fill"} value={n.fill ?? "#000000"} onChange={(c) => onPatch({ fill: c }, key("fill"))} onSeal={onSeal} />}
          {n.type === "rect" && num("cornerRadius", n.cornerRadius ?? 0, limits.cornerRadius, { label: "Corner radius" })}
          {hasStroke &&
            (n.stroke ? (
              <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                <ColorField label="Stroke" value={n.stroke} onChange={(c) => onPatch({ stroke: c }, key("stroke"))} onSeal={onSeal} />
                {num("strokeWidth", n.strokeWidth ?? 1, limits.strokeWidth, { label: "Stroke width" })}
                <Button variant="ghost" size="icon-sm" aria-label="Remove stroke" onClick={() => onPatch({ stroke: undefined, strokeWidth: undefined }, key("stroke-off"))}>
                  <XIcon />
                </Button>
              </div>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => onPatch({ stroke: "#282202", strokeWidth: 4 }, key("stroke-on"))}>
                <PlusIcon /> Add stroke
              </Button>
            ))}
        </section>
      )}
    </div>
  );
}
