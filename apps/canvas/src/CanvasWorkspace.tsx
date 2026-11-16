import { useEffect, useRef, useState } from "react";
import { Layer, Rect, Stage } from "react-konva";

export interface Artboard {
  width: number;
  height: number;
  background: string;
}

/** A square social post. The document model (Phase 3) will carry its own size. */
export const DEFAULT_ARTBOARD: Artboard = { width: 1080, height: 1080, background: "#FFFFFF" };

export interface CanvasWorkspaceProps {
  artboard: Artboard;
  /** Styles the host element, which fills the space the editor may use. */
  className?: string;
}

const MARGIN = 48;

// shortcut: draws a blank artboard fitted to the host. Selection, nodes, zoom and pan arrive in Phase 2.
export function CanvasWorkspace({ artboard, className }: CanvasWorkspaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Never upscale past 1:1, and keep a margin so the artboard's shadow isn't clipped.
  const scale = Math.min(
    (size.width - MARGIN * 2) / artboard.width,
    (size.height - MARGIN * 2) / artboard.height,
    1,
  );
  const fits = scale > 0;

  return (
    <div ref={host} className={className}>
      {size.width > 0 && size.height > 0 && (
        <Stage width={size.width} height={size.height}>
          <Layer
            x={(size.width - artboard.width * scale) / 2}
            y={(size.height - artboard.height * scale) / 2}
            scaleX={fits ? scale : 1}
            scaleY={fits ? scale : 1}
          >
            <Rect
              width={artboard.width}
              height={artboard.height}
              fill={artboard.background}
              shadowColor="#282202"
              shadowOpacity={0.18}
              shadowBlur={24}
              shadowOffsetY={6}
              listening={false}
            />
          </Layer>
        </Stage>
      )}
    </div>
  );
}
