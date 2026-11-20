import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Ellipse, Image as KonvaImage, Layer, Rect, Stage, Text, Transformer } from "react-konva";
import { clamp, containCrop, coverCrop, foldScale, limitPatch, MAX_ZOOM, MIN_ZOOM, round2, type CanvasDocument, type CanvasNode, type NodePatch } from "./document";
import { exportStage, type ExportOptions } from "./exportImage";
import { handleRules, layerRules, type StageMode } from "./stageMode";

export interface CanvasStageHandle {
  zoomBy(factor: number): void;
  /** Back to the zoom that shows the whole artboard. */
  fit(): void;
  exportImage(options: ExportOptions): Promise<Blob>;
}

export interface CanvasStageProps {
  doc: CanvasDocument;
  /**
   * "designer" (the default) edits everything. "marketing" is for a design made from a published template: nothing can be
   * dragged, resized or rotated, and only the layers in `selectable` react to the pointer; a click anywhere else, on a
   * locked layer included, goes through to the artboard and clears the selection. The server enforces the same rule.
   * "readonly" shows a submitted design: nothing reacts to the pointer (no selection, no handles); zoom and pan still work.
   * What each mode allows is in stageMode.ts.
   */
  mode?: StageMode;
  /** The layer ids Marketing may select (the revision's manifest). Used only in "marketing" mode. */
  selectable?: ReadonlySet<string>;
  selectedId: string | null;
  /** Decoded image per asset id. A layer whose image is not here yet is drawn as a grey placeholder. */
  images: ReadonlyMap<string, HTMLImageElement>;
  /** The real font family behind each name in the document (next/font generates them). */
  fonts?: Readonly<Record<string, string>>;
  onSelect(id: string | null): void;
  /** One finished drag or resize: position, rotation and size of a layer. */
  onChange(id: string, patch: NodePatch): void;
  onEditText?(id: string): void;
  onZoomChange?(scale: number): void;
  /** Styles the host element, which fills the space the editor may use. It shows data-panning while Space is held. */
  className?: string;
  ref?: React.Ref<CanvasStageHandle>;
}

interface View {
  scale: number;
  x: number;
  y: number;
}

const MARGIN = 48;
const MIN_BOX = 8;
const ALL_ANCHORS = ["top-left", "top-center", "top-right", "middle-right", "bottom-right", "bottom-center", "bottom-left", "middle-left"];
// Text grows by its width (side handles) or proportionally (corners); never by height alone.
const TEXT_ANCHORS = ["top-left", "top-right", "bottom-right", "bottom-left", "middle-right", "middle-left"];
const SELECTION = "#876114";

const isTextField = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function CanvasStage({ doc, mode = "designer", selectable, selectedId, images, fonts, onSelect, onChange, onEditText, onZoomChange, className, ref }: CanvasStageProps) {
  const { handles, outline } = handleRules(mode);
  const host = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const shadowLayer = useRef<Konva.Layer>(null);
  const contentLayer = useRef<Konva.Layer>(null);
  const uiLayer = useRef<Konva.Layer>(null);
  const transformer = useRef<Konva.Transformer>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // null = "fit the artboard", which follows the host's size; set once the person zooms or pans.
  const [manual, setManual] = useState<View | null>(null);
  const [panning, setPanning] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Space + drag pans. Only while focus is on the canvas (or nowhere), so Space still presses a focused button.
  useEffect(() => {
    const onCanvas = (t: EventTarget | null) => t === document.body || (t instanceof Node && !!host.current?.contains(t));
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTextField(e.target) || !onCanvas(e.target)) return;
      e.preventDefault();
      setPanning(true);
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setPanning(false);
    const release = () => setPanning(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);

  const fitScale = clamp(Math.min((size.width - MARGIN * 2) / doc.width, (size.height - MARGIN * 2) / doc.height, 1), MIN_ZOOM, 1);
  const view: View = manual ?? {
    scale: fitScale,
    x: (size.width - doc.width * fitScale) / 2,
    y: (size.height - doc.height * fitScale) / 2,
  };

  const zoomAt = (factor: number, at: { x: number; y: number }) => {
    const scale = clamp(view.scale * factor, MIN_ZOOM, MAX_ZOOM);
    const k = scale / view.scale;
    setManual({ scale, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k });
  };
  const centre = () => ({ x: size.width / 2, y: size.height / 2 });

  useImperativeHandle(ref, () => ({
    zoomBy: (factor) => zoomAt(factor, centre()),
    fit: () => setManual(null),
    exportImage: (options) => {
      const stage = stageRef.current;
      if (!stage || !shadowLayer.current || !uiLayer.current) return Promise.reject(new Error("The editor is not ready."));
      return exportStage(stage, [shadowLayer.current, uiLayer.current], doc, images, options);
    },
  }));

  useEffect(() => onZoomChange?.(view.scale), [view.scale, onZoomChange]);

  // A read-only stage has no selection, whatever the host passes: nothing is outlined.
  const selected = outline ? doc.nodes.find((n) => n.id === selectedId) : undefined;
  // The Transformer follows the selected Konva node. It is re-attached after every document change
  // because the node it holds may have been redrawn.
  useEffect(() => {
    const tr = transformer.current;
    if (!tr) return;
    const node = selected ? contentLayer.current?.findOne((n: Konva.Node) => n.id() === selected.id) : null;
    tr.nodes(node && node.isVisible() ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selected, doc, images]);

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const lines = e.evt.deltaMode === 1 ? 16 : 1; // Firefox reports a mouse wheel in lines
    const dx = e.evt.deltaX * lines;
    const dy = e.evt.deltaY * lines;
    if (e.evt.ctrlKey || e.evt.metaKey) zoomAt(Math.exp(-dy * 0.0025), stageRef.current?.getPointerPosition() ?? centre());
    else setManual({ ...view, x: view.x - dx, y: view.y - dy });
  };

  const focusCanvas = () => host.current?.focus({ preventScroll: true });
  const pressBackground = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    focusCanvas();
    if (panning) return;
    const t = e.target;
    if (t === t.getStage() || t.name() === "artboard") onSelect(null);
  };
  const pick = (id: string) => (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    focusCanvas();
    if (panning) return; // let the press reach the stage, which pans
    e.cancelBubble = true;
    onSelect(id);
  };

  const shared = (n: CanvasNode) => ({
    id: n.id,
    name: "node",
    x: n.x,
    y: n.y,
    rotation: n.rotation,
    opacity: n.opacity,
    visible: n.visible,
    // Marketing: a locked layer does not listen, so a click passes through it to a field beneath, or to the artboard.
    // Read-only: no layer listens. (stageMode.ts)
    draggable: !panning && layerRules(mode, selectable, n.id).draggable,
    listening: layerRules(mode, selectable, n.id).listening,
    perfectDrawEnabled: false,
    onMouseDown: pick(n.id),
    onTouchStart: pick(n.id),
    onDragEnd: (e: KonvaEventObject<DragEvent>) => {
      e.cancelBubble = true;
      // A drag can end past the limits (far off the artboard at low zoom). The document keeps the clamped
      // value, and so must the Konva node: if the clamp leaves the document unchanged nothing re-renders,
      // and the node would stay where the mouse left it.
      const patch = limitPatch(n, { x: round2(e.target.x()), y: round2(e.target.y()) });
      e.target.position({ x: patch.x ?? n.x, y: patch.y ?? n.y });
      onChange(n.id, patch);
    },
    onTransformEnd: (e: KonvaEventObject<Event>) => {
      // Konva leaves the resize as a scale on the node. Fold it into the size and reset it, so the
      // document never stores a scaled node. Position and rotation are held to the limits and written back
      // for the reason above; the size is drawn from the document, whose width and height are what is stored.
      const node = e.target;
      const sx = node.scaleX();
      const sy = node.scaleY();
      node.scaleX(1);
      node.scaleY(1);
      const patch = limitPatch(n, { x: round2(node.x()), y: round2(node.y()), rotation: round2(node.rotation()), ...foldScale(n, sx, sy) });
      node.position({ x: patch.x ?? n.x, y: patch.y ?? n.y });
      node.rotation(patch.rotation ?? n.rotation);
      onChange(n.id, patch);
    },
    ...(n.shadow && {
      shadowColor: n.shadow.color,
      shadowBlur: n.shadow.blur,
      shadowOffsetX: n.shadow.offsetX,
      shadowOffsetY: n.shadow.offsetY,
      shadowOpacity: n.shadow.opacity,
    }),
  });

  const paint = (n: CanvasNode) => ({ fill: n.fill, stroke: n.stroke, strokeWidth: n.stroke ? (n.strokeWidth ?? 1) : 0 });

  function renderNode(n: CanvasNode) {
    switch (n.type) {
      case "rect":
        return <Rect key={n.id} {...shared(n)} {...paint(n)} width={n.width} height={n.height} cornerRadius={n.cornerRadius ?? 0} />;
      case "ellipse":
        // Konva draws an ellipse from its centre; the offset puts its top-left corner at (x, y) like every other layer.
        return (
          <Ellipse key={n.id} {...shared(n)} {...paint(n)} radiusX={n.width / 2} radiusY={n.height / 2} offsetX={-n.width / 2} offsetY={-n.height / 2} />
        );
      case "text":
        return (
          <Text
            key={n.id}
            {...shared(n)}
            {...paint(n)}
            text={n.text}
            width={n.width}
            fontFamily={fonts?.[n.fontFamily] ?? n.fontFamily}
            fontSize={n.fontSize}
            fontStyle={n.fontStyle}
            align={n.align}
            lineHeight={n.lineHeight}
            letterSpacing={n.letterSpacing}
            onDblClick={mode === "readonly" ? undefined : () => onEditText?.(n.id)}
            onDblTap={mode === "readonly" ? undefined : () => onEditText?.(n.id)}
          />
        );
      case "image": {
        const img = images.get(n.assetId);
        if (!img) return <Rect key={n.id} {...shared(n)} width={n.width} height={n.height} fill="#D6D2C0" />;
        return (
          <KonvaImage
            key={n.id}
            {...shared(n)}
            image={img}
            width={n.width}
            height={n.height}
            crop={(n.fit === "contain" ? containCrop : coverCrop)(img.naturalWidth, img.naturalHeight, n.width, n.height)}
          />
        );
      }
      case "group":
        return null; // v1 has no way to create a group
    }
  }

  const keepRatio = selected?.type === "text" || selected?.type === "image";

  return (
    <div ref={host} tabIndex={-1} data-panning={panning || undefined} className={className}>
      {size.width > 0 && size.height > 0 && (
        <Stage
          ref={stageRef}
          width={size.width}
          height={size.height}
          x={view.x}
          y={view.y}
          scaleX={view.scale}
          scaleY={view.scale}
          draggable={panning}
          onWheel={onWheel}
          onMouseDown={pressBackground}
          onTouchStart={pressBackground}
          onDragEnd={(e) => {
            if (e.target === e.target.getStage()) setManual({ ...view, x: e.target.x(), y: e.target.y() });
          }}
        >
          <Layer ref={shadowLayer} listening={false}>
            <Rect width={doc.width} height={doc.height} fill="#FFFFFF" shadowColor="#282202" shadowOpacity={0.18} shadowBlur={24} shadowOffsetY={6} />
          </Layer>
          <Layer ref={contentLayer}>
            <Rect name="artboard" width={doc.width} height={doc.height} fill={doc.background.color} />
            {doc.nodes.map(renderNode)}
          </Layer>
          <Layer ref={uiLayer}>
            <Transformer
              ref={transformer}
              flipEnabled={false}
              keepRatio={keepRatio}
              enabledAnchors={!handles ? [] : selected?.type === "text" ? TEXT_ANCHORS : ALL_ANCHORS}
              rotateEnabled={handles}
              resizeEnabled={handles}
              rotationSnaps={[0, 90, 180, 270]}
              rotationSnapTolerance={4}
              anchorSize={9}
              anchorCornerRadius={2}
              anchorStroke={SELECTION}
              anchorFill="#FFFFFF"
              borderStroke={SELECTION}
              boundBoxFunc={(prev, next) => (next.width < MIN_BOX || next.height < MIN_BOX ? prev : next)}
            />
          </Layer>
        </Stage>
      )}
    </div>
  );
}
