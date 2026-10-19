import { useEffect, useRef, useState } from 'react';
import type { EditorSession } from '../session.ts';
import type { Viewport } from '../../model/types.ts';
import { renderRgba } from '../../export/png.ts';
import { ru } from '../../i18n/ru.ts';
import { axisLabel } from '../symmetry/axisLabel.ts';
import { Icon } from '../icons.tsx';
import { selectionSizeLabel } from '../session.ts';
import { axis2FromCellSpace, backingStoreSize, containViewport, fitViewport, gestureViewport, panBy, resizeViewport, screenToCell, snapAxis, zoomAt } from './coords.ts';
import { snapRotation, type SelectionHandle, type SelectionRect } from '../selection/selection.ts';
import { gripAt, placeTrace, type SourceCrop, type TraceFrame, type TraceGrip, type TraceSprite } from '../trace/trace.ts';

type AxisName = 'vertical' | 'horizontal';

export function CanvasView({
  session,
  frame,
  axisSnap,
  axisLocked,
  onChange,
  onTrace,
}: {
  session: EditorSession;
  frame: number;
  axisSnap: 'center' | 'edge';
  axisLocked: boolean;
  onChange: () => void;
  onTrace: (sprite: TraceSprite) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const pixelRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; midX: number; midY: number; viewport: Viewport } | null>(null);
  const hands = useRef(false);
  const armed = useRef<{ x: number; y: number } | null>(null);
  const pasteDrag = useRef<{ x: number; y: number } | null>(null);
  const resizeDrag = useRef<SelectionHandle | null>(null);
  const rotateDrag = useRef(false);
  const panning = useRef(false);
  const axisDrag = useRef<AxisName | null>(null);
  const traceDrag = useRef<{ id: string; grip: TraceGrip; frame: TraceFrame; crop: SourceCrop; x: number; y: number } | null>(null);
  const lastPan = useRef({ x: 0, y: 0 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const saveTimer = useRef(0);
  const fitted = useRef(false);
  const space = useRef(false);
  const [readout, setReadout] = useState<string | null>(null);
  const [axisCursor, setAxisCursor] = useState<AxisName | null>(null);
  const [draftHex, setDraftHex] = useState<string | null>(null);
  const colorTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(colorTimer.current), []);

  useEffect(() => {
    draw(wrapRef.current, pixelRef.current, overlayRef.current, session, axisDrag.current);
  }, [session, frame]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      const previous = sizeRef.current;
      if (previous.width !== 0 && Math.abs(rect.width - previous.width) < 1 && Math.abs(rect.height - previous.height) < 1) return;
      const viewport = session.doc.viewport;
      const untouched = viewport.scale === 1 && viewport.panX === 16 && viewport.panY === 16;
      sizeRef.current = { width: rect.width, height: rect.height };
      if (!fitted.current && !untouched) {
        fitted.current = true;
        const contained = containViewport(viewport, rect.width, rect.height, session.doc.width, session.doc.height);
        const moved = contained.panX !== viewport.panX || contained.panY !== viewport.panY || contained.scale !== viewport.scale;
        if (moved) remember(session, contained, onChange, saveTimer, wrap);
        else draw(wrap, pixelRef.current, overlayRef.current, session, axisDrag.current);
        return;
      }
      fitted.current = true;
      const next = previous.width === 0 && untouched
        ? fitViewport(rect.width, rect.height, session.doc.width, session.doc.height, viewport.cellSize)
        : resizeViewport(viewport, previous.width === 0 ? rect : previous, { width: rect.width, height: rect.height });
      if (previous.width === 0 && untouched) remember(session, next, onChange, saveTimer, wrap);
      else if (previous.width !== 0) remember(session, next, onChange, saveTimer, wrap);
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [session, onChange]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const viewport = zoomAt(
        session.doc.viewport,
        event.clientX - rect.left,
        event.clientY - rect.top,
        session.doc.viewport.scale * (event.deltaY < 0 ? 1.1 : 0.9),
      );
      remember(session, viewport, onChange, saveTimer, wrap);
    };
    const blockTouch = (event: TouchEvent) => {
      if (event.touches.length > 0) event.preventDefault();
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    wrap.addEventListener('touchmove', blockTouch, { passive: false });
    return () => {
      wrap.removeEventListener('wheel', onWheel);
      wrap.removeEventListener('touchmove', blockTouch);
    };
  }, [session, onChange]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || editingTarget(event.target)) return;
      event.preventDefault();
      space.current = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') space.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  function commitTrace(): void {
    const tracing = traceDrag.current;
    traceDrag.current = null;
    if (!tracing) return;
    const sprite = session.traces.find((item) => item.id === tracing.id);
    if (sprite) onTrace(sprite);
  }

  function cellAt(event: { clientX: number; clientY: number }) {
    const canvas = pixelRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return screenToCell(event.clientX, event.clientY, rect, session.doc.viewport, window.devicePixelRatio || 1);
  }

  function showAxis(which: AxisName): void {
    const symmetry = session.doc.symmetry;
    const axis2 = which === 'vertical' ? symmetry.axisX2 : symmetry.axisY2;
    const edge = which === 'vertical' ? session.doc.width : session.doc.height;
    const text = axisLabel(axis2, edge, which === 'vertical');
    setReadout((current) => current === text ? current : text);
  }

  function fit(): void {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    remember(
      session,
      fitViewport(rect.width, rect.height, session.doc.width, session.doc.height, session.doc.viewport.cellSize),
      onChange,
      saveTimer,
      wrap,
    );
  }

  function resetZoom(): void {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    remember(session, zoomAt(session.doc.viewport, rect.width / 2, rect.height / 2, 1), onChange, saveTimer, wrap);
  }

  const cursor = axisCursor === 'vertical'
    ? ' is-axis-x'
    : axisCursor === 'horizontal'
      ? ' is-axis-y'
      : session.tool === 'pan'
        ? ' is-pan'
        : session.tool === 'trace'
          ? ' is-trace'
          : '';
  const rectSize = session.liveRectSize();
  const live = rectSize ?? session.liveSelection();

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap${cursor}`}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button === 2) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // The pointer can already be gone after pointercancel. The gesture still runs.
        }
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size >= 2) {
          hands.current = true;
          armed.current = null;
          panning.current = false;
          pasteDrag.current = null;
          resizeDrag.current = null;
          rotateDrag.current = false;
          axisDrag.current = null;
          setAxisCursor(null);
          setReadout(null);
          session.cancelGesture();
          commitTrace();
          const gesture = fingerPair(pointers.current, pixelRef.current);
          if (gesture) pinch.current = { ...gesture, viewport: { ...session.doc.viewport } };
          onChange();
          return;
        }
        if (event.button === 1 || space.current) {
          panning.current = true;
          lastPan.current = { x: event.clientX, y: event.clientY };
          return;
        }
        if (session.pasteOrigin) {
          pasteDrag.current = cellAt(event);
          return;
        }
        if (session.tool === 'select' && session.selection) {
          if (rotateHandleAt(session, event.clientX, event.clientY, event.currentTarget)) {
            session.startRotate();
            rotateDrag.current = true;
            return;
          }
          const handle = selectionHandleAt(session, event.clientX, event.clientY, event.currentTarget);
          if (handle) {
            session.startScale();
            resizeDrag.current = handle;
            return;
          }
        }
        if (session.tool === 'trace') {
          const point = cellSpace(event, pixelRef.current, session);
          const hitTrace = point ? traceAt(session, point.x, point.y) : null;
          if (point && hitTrace) {
            const sprite = focusTrace(session, hitTrace.id);
            if (sprite) {
              traceDrag.current = { id: sprite.id, grip: hitTrace.grip, frame: { ...sprite.frame }, crop: { ...sprite.crop }, x: point.x, y: point.y };
            }
          } else {
            session.activeTraceId = null;
          }
          onChange();
          return;
        }
        const hit = axisLocked ? null : axisHit(session, event.clientX, event.clientY, pixelRef.current);
        if (hit) {
          axisDrag.current = hit;
          setAxisCursor(hit);
          showAxis(hit);
          onChange();
          return;
        }
        if (session.tool === 'pan') {
          panning.current = true;
          lastPan.current = { x: event.clientX, y: event.clientY };
          return;
        }
        armed.current = cellAt(event);
      }}
      onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (hands.current) {
          const gesture = fingerPair(pointers.current, pixelRef.current);
          const start = pinch.current;
          if (gesture && start) {
            remember(session, gestureViewport(start.viewport, start, gesture.midX, gesture.midY, gesture.distance), onChange, saveTimer, wrapRef.current);
          }
          return;
        }
        if (axisDrag.current && pixelRef.current) {
          dragAxis(session, axisDrag.current, event.clientX, event.clientY, pixelRef.current, axisSnap);
          showAxis(axisDrag.current);
          onChange();
          window.clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(() => session.setView({ symmetry: session.doc.symmetry }), 300);
          return;
        }
        if (panning.current) {
          const viewport = panBy(session.doc.viewport, event.clientX - lastPan.current.x, event.clientY - lastPan.current.y);
          lastPan.current = { x: event.clientX, y: event.clientY };
          remember(session, viewport, onChange, saveTimer, wrapRef.current);
          return;
        }
        const tracing = traceDrag.current;
        if (tracing) {
          const point = cellSpace(event, pixelRef.current, session);
          const sprite = session.traces.find((item) => item.id === tracing.id);
          if (point && sprite) {
            const placed = placeTrace(tracing.frame, tracing.crop, tracing.grip, point.x, point.y, tracing.x, tracing.y);
            sprite.frame = placed.frame;
            sprite.crop = placed.crop;
          }
          onChange();
          return;
        }
        if (rotateDrag.current) {
          session.previewRotate(snapRotation(rotationAt(session, event.clientX, event.clientY, event.currentTarget)));
          onChange();
          return;
        }
        if (resizeDrag.current) {
          const cell = cellAt(event);
          if (cell) session.previewScale(resizeDrag.current, cell);
          onChange();
          return;
        }
        if (pasteDrag.current) {
          const cell = cellAt(event);
          if (cell) {
            const dx = cell.x - pasteDrag.current.x;
            const dy = cell.y - pasteDrag.current.y;
            if (dx !== 0 || dy !== 0) {
              session.movePaste(dx, dy);
              pasteDrag.current = cell;
            }
          }
          onChange();
          return;
        }
        if (armed.current) {
          session.pointerDown(armed.current);
          armed.current = null;
        }
        session.pointerMove(cellAt(event));
        onChange();
      }}
      onPointerUp={(event) => {
        pointers.current.delete(event.pointerId);
        if (pointers.current.size < 2) pinch.current = null;
        if (hands.current) {
          if (pointers.current.size === 0) hands.current = false;
          onChange();
          return;
        }
        const draggedAxis = axisDrag.current !== null;
        axisDrag.current = null;
        setAxisCursor(null);
        setReadout(null);
        if (panning.current) {
          panning.current = false;
          onChange();
          return;
        }
        if (resizeDrag.current || rotateDrag.current) {
          const rotating = rotateDrag.current;
          resizeDrag.current = null;
          rotateDrag.current = false;
          if (rotating) session.commitRotate();
          else session.commitScale();
          onChange();
          return;
        }
        if (traceDrag.current) {
          commitTrace();
          onChange();
          return;
        }
        if (pasteDrag.current) {
          pasteDrag.current = null;
          session.confirmPaste();
          onChange();
          return;
        }
        if (draggedAxis) {
          onChange();
          return;
        }
        if (armed.current) {
          session.pointerDown(armed.current);
          armed.current = null;
        }
        session.pointerUp();
        onChange();
      }}
      onPointerCancel={() => {
        pointers.current.clear();
        pinch.current = null;
        hands.current = false;
        armed.current = null;
        pasteDrag.current = null;
        resizeDrag.current = null;
        rotateDrag.current = false;
        panning.current = false;
        commitTrace();
        axisDrag.current = null;
        setAxisCursor(null);
        setReadout(null);
        session.cancelGesture();
        onChange();
      }}
    >
      <canvas ref={pixelRef} />
      <canvas ref={overlayRef} className="overlay" />
      <div className="color-dock" onPointerDown={(event) => event.stopPropagation()}>
        <div className="color-pair">
          <button
            type="button"
            className="color-prev"
            style={session.previousSlot ? { background: session.doc.palette[session.previousSlot - 1]?.hex ?? '#1a1614' } : undefined}
            aria-label={ru.previousColor}
            title={ru.previousColor}
            disabled={session.previousSlot == null}
            onClick={() => { session.swapColors(); onChange(); }}
          />
          <button
            type="button"
            className="color-now"
            style={{ background: session.doc.palette[session.colorSlot - 1]?.hex ?? '#1a1614' }}
            aria-label={ru.currentColor}
            title={ru.currentColor}
            onClick={() => { session.swapColors(); onChange(); }}
          />
        </div>
        <div className="palette" aria-label={ru.palette}>
          <label className="wheel" title={ru.pickColor}>
            <input
              type="color"
              aria-label={ru.pickColor}
              value={draftHex ?? session.doc.palette[session.colorSlot - 1]?.hex ?? '#1a1614'}
              onChange={(event) => {
                const hex = event.target.value;
                setDraftHex(hex);
                window.clearTimeout(colorTimer.current);
                colorTimer.current = window.setTimeout(() => {
                  session.useColor(hex);
                  setDraftHex(null);
                  onChange();
                }, 250);
              }}
            />
          </label>
          {session.doc.palette.map((color, index) => {
            if (color.hidden) return null;
            const slot = index + 1;
            return (
              <button
                key={color.id}
                type="button"
                className="swatch"
                style={{ background: color.hex }}
                aria-label={color.hex}
                title={color.hex}
                aria-pressed={session.colorSlot === slot}
                onClick={() => { session.setColorSlot(slot); onChange(); }}
              />
            );
          })}
          <button
            type="button"
            className="icon-btn"
            aria-label={ru.deleteColor}
            title={ru.deleteColor}
            disabled={session.doc.palette.filter((color) => !color.hidden).length < 2}
            onClick={() => { session.dismissColor(session.colorSlot - 1); onChange(); }}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>
      {readout ? <p className="axis-readout">{readout}</p> : null}
      {live ? <p className="selection-readout">{selectionSizeLabel(live)}</p> : null}
      <div className="canvas-chrome" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" className="icon-btn" aria-label={ru.fit} title={ru.fit} onClick={fit}>
          <Icon name="fit" />
        </button>
        <button type="button" className="zoom-label" aria-label={ru.zoomReset} title={ru.zoomReset} onClick={resetZoom}>
          1∶1
        </button>
      </div>
    </div>
  );
}

function fingerPair(
  pointers: Map<number, { x: number; y: number }>,
  canvas: HTMLCanvasElement | null,
): { midX: number; midY: number; distance: number } | null {
  if (!canvas || pointers.size < 2) return null;
  const [a, b] = [...pointers.values()];
  if (!a || !b) return null;
  const rect = canvas.getBoundingClientRect();
  return {
    midX: (a.x + b.x) / 2 - rect.left,
    midY: (a.y + b.y) / 2 - rect.top,
    distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
  };
}

function editingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function remember(
  session: EditorSession,
  viewport: Viewport,
  onChange: () => void,
  saveTimer: { current: number },
  wrap: HTMLElement | null,
): void {
  const rect = wrap?.getBoundingClientRect();
  const next = rect && rect.width > 1 && rect.height > 1
    ? containViewport(viewport, rect.width, rect.height, session.doc.width, session.doc.height)
    : viewport;
  session.doc = { ...session.doc, viewport: next };
  onChange();
  window.clearTimeout(saveTimer.current);
  saveTimer.current = window.setTimeout(() => session.setView({ viewport: session.doc.viewport }), 400);
}

function draw(
  wrap: HTMLDivElement | null,
  pixels: HTMLCanvasElement | null,
  overlay: HTMLCanvasElement | null,
  session: EditorSession,
  dragging: AxisName | null,
): void {
  if (!wrap || !pixels || !overlay) return;
  const rect = wrap.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const backing = backingStoreSize(rect.width, rect.height, dpr);
  for (const canvas of [pixels, overlay]) {
    if (canvas.width !== backing.width || canvas.height !== backing.height) {
      canvas.width = backing.width;
      canvas.height = backing.height;
    }
  }
  const pixelCtx = pixels.getContext('2d');
  const overlayCtx = overlay.getContext('2d');
  if (!pixelCtx || !overlayCtx) return;
  const pictures = session.traces.filter((trace) => trace.image);
  const image = renderRgba(session.doc, {
    grid: false,
    checker: false,
    pixelsPerCell: 1,
    border: false,
    checkerBlock: session.doc.checkerBlock,
  });
  const sample = document.createElement('canvas');
  sample.width = image.width;
  sample.height = image.height;
  const sampleCtx = sample.getContext('2d');
  if (!sampleCtx) return;
  sampleCtx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  pixelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pixelCtx.clearRect(0, 0, rect.width, rect.height);
  const { viewport } = session.doc;
  const drawW = session.doc.width * viewport.cellSize * viewport.scale;
  const drawH = session.doc.height * viewport.cellSize * viewport.scale;
  if (session.doc.checkerVisible) fillChecker(pixelCtx, viewport, session.doc.width, session.doc.height, session.doc.checkerBlock);
  pixelCtx.imageSmoothingEnabled = true;
  pixelCtx.imageSmoothingQuality = 'high';
  for (const trace of pictures) drawTrace(pixelCtx, trace, viewport);
  pixelCtx.imageSmoothingEnabled = false;
  pixelCtx.drawImage(sample, viewport.panX, viewport.panY, drawW, drawH);

  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  overlayCtx.clearRect(0, 0, rect.width, rect.height);
  drawGrid(overlayCtx, session, viewport, drawW, drawH);
  const preview = session.preview();
  const cellPx = viewport.cellSize * viewport.scale;
  if (preview) {
    overlayCtx.fillStyle = 'rgba(180, 51, 74, 0.45)';
    for (const point of preview.points) {
      overlayCtx.fillRect(viewport.panX + point.x * cellPx, viewport.panY + point.y * cellPx, cellPx, cellPx);
    }
  }
  if (session.selection) {
    strokeRect(overlayCtx, session.selection, viewport, '#243e66');
    if (session.tool === 'select' && session.selection) drawHandles(overlayCtx, session.selection, viewport, session.rotationDegrees);
  }
  if (session.pasteOrigin && session.clipboard) {
    const clip = session.clipboard;
    overlayCtx.fillStyle = 'rgba(180, 51, 74, 0.45)';
    for (let y = 0; y < clip.height; y += 1) {
      for (let x = 0; x < clip.width; x += 1) {
        if (clip.cells[y * clip.width + x] === 0) continue;
        overlayCtx.fillRect(viewport.panX + (session.pasteOrigin.x + x) * cellPx, viewport.panY + (session.pasteOrigin.y + y) * cellPx, cellPx, cellPx);
      }
    }
  }
  drawAxes(overlayCtx, session, viewport, dragging);
  if (session.tool === 'trace') {
    const active = session.traces.find((trace) => trace.id === session.activeTraceId);
    if (active) drawTraceGrips(overlayCtx, active, viewport);
  }
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  session: EditorSession,
  viewport: Viewport,
  drawW: number,
  drawH: number,
): void {
  ctx.strokeStyle = 'rgba(36, 28, 24, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(viewport.panX + 0.5, viewport.panY + 0.5, Math.max(0, drawW - 1), Math.max(0, drawH - 1));
  if (!session.doc.gridVisible) return;
  const cellPx = viewport.cellSize * viewport.scale;
  // ponytail: every 8th line below 6px per cell. A mip-style grid would replace the fixed step.
  const step = cellPx >= 6 ? 1 : cellPx * 8 >= 3 ? 8 : 0;
  if (step === 0) return;
  ctx.beginPath();
  for (let x = 0; x <= session.doc.width; x += step) {
    const px = viewport.panX + x * cellPx + 0.5;
    ctx.moveTo(px, viewport.panY);
    ctx.lineTo(px, viewport.panY + drawH);
  }
  for (let y = 0; y <= session.doc.height; y += step) {
    const py = viewport.panY + y * cellPx + 0.5;
    ctx.moveTo(viewport.panX, py);
    ctx.lineTo(viewport.panX + drawW, py);
  }
  ctx.strokeStyle = step === 1 ? 'rgba(36, 28, 24, 0.62)' : 'rgba(36, 28, 24, 0.45)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function strokeRect(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  viewport: Viewport,
  color: string,
): void {
  const cellPx = viewport.cellSize * viewport.scale;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(viewport.panX + rect.x * cellPx, viewport.panY + rect.y * cellPx, rect.width * cellPx, rect.height * cellPx);
}

const ROTATE_LIFT = 36;
const HANDLE_HIT = 22;

function rotateKnob(rect: SelectionRect, viewport: Viewport): { x: number; y: number } {
  const cellPx = viewport.cellSize * viewport.scale;
  const left = viewport.panX + rect.x * cellPx;
  const top = viewport.panY + rect.y * cellPx;
  return { x: left + (rect.width * cellPx) / 2, y: top - ROTATE_LIFT };
}

function pointerIn(wrap: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const box = wrap.getBoundingClientRect();
  return { x: clientX - box.left, y: clientY - box.top };
}

function rotationAt(session: EditorSession, clientX: number, clientY: number, wrap: HTMLElement): number {
  const rect = session.selection;
  if (!rect) return 0;
  const point = pointerIn(wrap, clientX, clientY);
  const cellPx = session.doc.viewport.cellSize * session.doc.viewport.scale;
  const left = session.doc.viewport.panX + rect.x * cellPx;
  const top = session.doc.viewport.panY + rect.y * cellPx;
  const cx = left + (rect.width * cellPx) / 2;
  const cy = top + (rect.height * cellPx) / 2;
  return Math.atan2(point.y - cy, point.x - cx) + Math.PI / 2;
}

function rotateHandleAt(session: EditorSession, clientX: number, clientY: number, wrap: HTMLElement): boolean {
  const rect = session.selection;
  if (!rect || wrap.getBoundingClientRect().width <= 0) return false;
  const point = pointerIn(wrap, clientX, clientY);
  const knob = rotateKnob(rect, session.doc.viewport);
  return Math.hypot(point.x - knob.x, point.y - knob.y) <= HANDLE_HIT;
}

function drawHandles(
  ctx: CanvasRenderingContext2D,
  rect: SelectionRect,
  viewport: Viewport,
  degrees: number | null,
): void {
  const cellPx = viewport.cellSize * viewport.scale;
  const left = viewport.panX + rect.x * cellPx;
  const top = viewport.panY + rect.y * cellPx;
  const right = left + rect.width * cellPx;
  const bottom = top + rect.height * cellPx;
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;
  const size = 7;
  ctx.fillStyle = '#f7f3eb';
  ctx.strokeStyle = '#243e66';
  ctx.lineWidth = 2;
  for (const [x, y] of [[left, top], [midX, top], [right, top], [left, midY], [right, midY], [left, bottom], [midX, bottom], [right, bottom]]) {
    ctx.fillRect(x - size, y - size, size * 2, size * 2);
    ctx.strokeRect(x - size, y - size, size * 2, size * 2);
  }
  const knob = rotateKnob(rect, viewport);
  ctx.beginPath();
  ctx.moveTo(midX, top);
  ctx.lineTo(knob.x, knob.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(knob.x, knob.y, size, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (degrees != null) {
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#243e66';
    ctx.fillText(`${degrees}°`, knob.x, knob.y - 10);
  }
}

function selectionHandleAt(
  session: EditorSession,
  clientX: number,
  clientY: number,
  wrap: HTMLElement,
): SelectionHandle | null {
  const area = session.selection;
  const box = wrap.getBoundingClientRect();
  if (!area || box.width <= 0 || box.height <= 0) return null;
  const x = clientX - box.left;
  const y = clientY - box.top;
  const { viewport } = session.doc;
  const cellPx = viewport.cellSize * viewport.scale;
  const left = viewport.panX + area.x * cellPx;
  const top = viewport.panY + area.y * cellPx;
  const right = left + area.width * cellPx;
  const bottom = top + area.height * cellPx;
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;
  if (x > left + HANDLE_HIT && x < right - HANDLE_HIT && y > top + HANDLE_HIT && y < bottom - HANDLE_HIT) return null;
  const points: [SelectionHandle, number, number][] = [
    ['nw', left, top], ['ne', right, top], ['sw', left, bottom], ['se', right, bottom],
    ['n', midX, top], ['s', midX, bottom], ['w', left, midY], ['e', right, midY],
  ];
  let best: SelectionHandle | null = null;
  let bestDist = HANDLE_HIT * HANDLE_HIT;
  for (const [handle, hx, hy] of points) {
    const dx = x - hx;
    const dy = y - hy;
    const dist = dx * dx + dy * dy;
    if (dist <= bestDist) {
      bestDist = dist;
      best = handle;
    }
  }
  return best;
}

function drawAxes(
  ctx: CanvasRenderingContext2D,
  session: EditorSession,
  viewport: Viewport,
  dragging: AxisName | null,
): void {
  const symmetry = session.doc.symmetry;
  if (symmetry.mode === 'off') return;
  const cellPx = viewport.cellSize * viewport.scale;
  ctx.setLineDash([]);
  const strokeAxis = (which: AxisName) => {
    ctx.beginPath();
    if (which === 'vertical') {
      const x = viewport.panX + (symmetry.axisX2 / 2) * cellPx;
      ctx.moveTo(x, viewport.panY);
      ctx.lineTo(x, viewport.panY + session.doc.height * cellPx);
    } else {
      const y = viewport.panY + (symmetry.axisY2 / 2) * cellPx;
      ctx.moveTo(viewport.panX, y);
      ctx.lineTo(viewport.panX + session.doc.width * cellPx, y);
    }
    ctx.strokeStyle = 'rgba(247, 243, 235, 0.92)';
    ctx.lineWidth = dragging === which ? 4 : 2;
    ctx.stroke();
    ctx.strokeStyle = '#b4334a';
    ctx.lineWidth = dragging === which ? 2 : 1;
    ctx.stroke();
  };
  if (symmetry.mode === 'vertical' || symmetry.mode === 'both') {
    strokeAxis('vertical');
    const handle = axisHandle('vertical', session, viewport);
    drawHandle(ctx, handle.x, handle.y);
  }
  if (symmetry.mode === 'horizontal' || symmetry.mode === 'both') {
    strokeAxis('horizontal');
    const handle = axisHandle('horizontal', session, viewport);
    drawHandle(ctx, handle.x, handle.y);
  }
}

function axisHandle(which: AxisName, session: EditorSession, viewport: Viewport): { x: number; y: number } {
  const cellPx = viewport.cellSize * viewport.scale;
  const symmetry = session.doc.symmetry;
  if (which === 'vertical') {
    return {
      x: viewport.panX + (symmetry.axisX2 / 2) * cellPx,
      y: viewport.panY + session.doc.height * cellPx * 0.22,
    };
  }
  return {
    x: viewport.panX + session.doc.width * cellPx * 0.22,
    y: viewport.panY + (symmetry.axisY2 / 2) * cellPx,
  };
}

function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fillStyle = '#f7f3eb';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#b4334a';
  ctx.stroke();
}

function axisHit(
  session: EditorSession,
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement | null,
): AxisName | null {
  const symmetry = session.doc.symmetry;
  if (!canvas || symmetry.mode === 'off') return null;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const { panX, panY, scale, cellSize } = session.doc.viewport;
  const axisX = panX + (symmetry.axisX2 / 2) * cellSize * scale;
  const axisY = panY + (symmetry.axisY2 / 2) * cellSize * scale;
  const verticalHandle = axisHandle('vertical', session, session.doc.viewport);
  const horizontalHandle = axisHandle('horizontal', session, session.doc.viewport);
  const hits: { which: AxisName; dist: number }[] = [];
  if (symmetry.mode === 'vertical' || symmetry.mode === 'both') {
    const line = Math.abs(x - axisX);
    const handle = Math.hypot(x - verticalHandle.x, y - verticalHandle.y);
    if (line <= 12 || handle <= 16) hits.push({ which: 'vertical', dist: Math.min(line, handle) });
  }
  if (symmetry.mode === 'horizontal' || symmetry.mode === 'both') {
    const line = Math.abs(y - axisY);
    const handle = Math.hypot(x - horizontalHandle.x, y - horizontalHandle.y);
    if (line <= 12 || handle <= 16) hits.push({ which: 'horizontal', dist: Math.min(line, handle) });
  }
  hits.sort((a, b) => a.dist - b.dist);
  return hits[0]?.which ?? null;
}

function dragAxis(
  session: EditorSession,
  which: AxisName,
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement,
  snap: 'center' | 'edge',
): void {
  const rect = canvas.getBoundingClientRect();
  const { panX, panY, scale, cellSize } = session.doc.viewport;
  const symmetry = session.doc.symmetry;
  if (which === 'vertical') {
    const cell = (clientX - rect.left - panX) / scale / cellSize;
    const axisX2 = clampAxis(snapAxis(axis2FromCellSpace(cell), snap), session.doc.width);
    session.doc = { ...session.doc, symmetry: { ...symmetry, axisX2 } };
  } else {
    const cell = (clientY - rect.top - panY) / scale / cellSize;
    const axisY2 = clampAxis(snapAxis(axis2FromCellSpace(cell), snap), session.doc.height);
    session.doc = { ...session.doc, symmetry: { ...symmetry, axisY2 } };
  }
}

function clampAxis(axis2: number, edge: number): number {
  return Math.max(0, Math.min(edge * 2, axis2));
}

function cellSpace(
  event: { clientX: number; clientY: number },
  canvas: HTMLCanvasElement | null,
  session: EditorSession,
): { x: number; y: number } | null {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const { panX, panY, scale, cellSize } = session.doc.viewport;
  const cellPx = cellSize * scale;
  if (cellPx <= 0) return null;
  return { x: (event.clientX - rect.left - panX) / cellPx, y: (event.clientY - rect.top - panY) / cellPx };
}

function traceAt(session: EditorSession, cellX: number, cellY: number): { id: string; grip: TraceGrip } | null {
  const cellPx = session.doc.viewport.cellSize * session.doc.viewport.scale;
  const slop = 22 / Math.max(cellPx, 0.5);
  for (let index = session.traces.length - 1; index >= 0; index -= 1) {
    const trace = session.traces[index];
    if (!trace) continue;
    const grip = gripAt(trace.frame, cellX, cellY, slop);
    if (grip) return { id: trace.id, grip };
  }
  return null;
}

function focusTrace(session: EditorSession, id: string): TraceSprite | null {
  const index = session.traces.findIndex((trace) => trace.id === id);
  if (index < 0) return null;
  const [sprite] = session.traces.splice(index, 1);
  if (!sprite) return null;
  session.traces.push(sprite);
  session.activeTraceId = id;
  return sprite;
}

function drawTrace(ctx: CanvasRenderingContext2D, trace: TraceSprite, viewport: Viewport): void {
  if (!trace.image) return;
  const cellPx = viewport.cellSize * viewport.scale;
  const cx = viewport.panX + (trace.frame.x + trace.frame.width / 2) * cellPx;
  const cy = viewport.panY + (trace.frame.y + trace.frame.height / 2) * cellPx;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(trace.frame.rotation);
  ctx.globalAlpha = trace.opacity;
  ctx.drawImage(
    trace.image,
    trace.crop.x * trace.naturalWidth,
    trace.crop.y * trace.naturalHeight,
    Math.max(1, trace.crop.width * trace.naturalWidth),
    Math.max(1, trace.crop.height * trace.naturalHeight),
    (-trace.frame.width * cellPx) / 2,
    (-trace.frame.height * cellPx) / 2,
    trace.frame.width * cellPx,
    trace.frame.height * cellPx,
  );
  ctx.restore();
}

function drawTraceGrips(ctx: CanvasRenderingContext2D, trace: TraceSprite, viewport: Viewport): void {
  const cellPx = viewport.cellSize * viewport.scale;
  const cx = viewport.panX + (trace.frame.x + trace.frame.width / 2) * cellPx;
  const cy = viewport.panY + (trace.frame.y + trace.frame.height / 2) * cellPx;
  const dw = trace.frame.width * cellPx;
  const dh = trace.frame.height * cellPx;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(trace.frame.rotation);
  ctx.strokeStyle = '#243e66';
  ctx.lineWidth = 2;
  ctx.strokeRect(-dw / 2, -dh / 2, dw, dh);
  ctx.beginPath();
  ctx.moveTo(0, -dh / 2);
  ctx.lineTo(0, -dh / 2 - 40);
  ctx.stroke();
  drawHandle(ctx, 0, -dh / 2 - 40);
  ctx.fillStyle = '#f7f3eb';
  const marks: [number, number][] = [
    [-dw / 2, -dh / 2], [dw / 2, -dh / 2], [-dw / 2, dh / 2], [dw / 2, dh / 2],
    [0, -dh / 2], [0, dh / 2], [-dw / 2, 0], [dw / 2, 0],
  ];
  for (const [x, y] of marks) {
    ctx.fillRect(x - 5, y - 5, 10, 10);
    ctx.strokeRect(x - 5, y - 5, 10, 10);
  }
  ctx.restore();
}

function fillChecker(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  gridWidth: number,
  gridHeight: number,
  block: number,
): void {
  // A repeating pattern is painted in device pixels, so on a tablet the squares leave the cells and the gap grows with zoom.
  const cellPx = viewport.cellSize * viewport.scale;
  const span = Math.max(1, block) * cellPx;
  const { panX, panY } = viewport;
  const drawW = gridWidth * cellPx;
  const drawH = gridHeight * cellPx;
  const cols = Math.ceil(gridWidth / Math.max(1, block));
  const rows = Math.ceil(gridHeight / Math.max(1, block));
  ctx.save();
  ctx.beginPath();
  ctx.rect(panX, panY, drawW, drawH);
  ctx.clip();
  ctx.fillStyle = '#e8e2d8';
  ctx.fillRect(panX, panY, drawW, drawH);
  ctx.beginPath();
  for (let y = 0; y < rows; y += 1) {
    for (let x = y % 2 === 0 ? 1 : 0; x < cols; x += 2) {
      ctx.rect(panX + x * span, panY + y * span, span, span);
    }
  }
  ctx.fillStyle = '#c4bcb0';
  ctx.fill();
  ctx.restore();
}
