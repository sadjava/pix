import { useEffect, useRef, useState } from 'react';
import type { EditorSession } from '../session.ts';
import type { Viewport } from '../../model/types.ts';
import { renderRgba } from '../../export/png.ts';
import { ru } from '../../i18n/ru.ts';
import { axisLabel } from '../symmetry/axisLabel.ts';
import { Icon } from '../icons.tsx';
import { selectionSizeLabel } from '../session.ts';
import { axis2FromCellSpace, backingStoreSize, fitViewport, gestureViewport, panBy, resizeViewport, screenToCell, snapAxis, zoomAt } from './coords.ts';

type AxisName = 'vertical' | 'horizontal';

export function CanvasView({
  session,
  frame,
  axisSnap,
  axisLocked,
  onChange,
}: {
  session: EditorSession;
  frame: number;
  axisSnap: 'center' | 'edge';
  axisLocked: boolean;
  onChange: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const pixelRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; midX: number; midY: number; viewport: Viewport } | null>(null);
  const hands = useRef(false);
  const armed = useRef<{ x: number; y: number } | null>(null);
  const pasteDrag = useRef<{ x: number; y: number } | null>(null);
  const panning = useRef(false);
  const axisDrag = useRef<AxisName | null>(null);
  const lastPan = useRef({ x: 0, y: 0 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const saveTimer = useRef(0);
  const fitted = useRef(false);
  const space = useRef(false);
  const [readout, setReadout] = useState<string | null>(null);
  const [axisCursor, setAxisCursor] = useState<AxisName | null>(null);

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
        draw(wrap, pixelRef.current, overlayRef.current, session, axisDrag.current);
        return;
      }
      fitted.current = true;
      const next = previous.width === 0 && untouched
        ? fitViewport(rect.width, rect.height, session.doc.width, session.doc.height, viewport.cellSize)
        : resizeViewport(viewport, previous.width === 0 ? rect : previous, { width: rect.width, height: rect.height });
      if (previous.width === 0 && untouched) remember(session, next, onChange, saveTimer);
      else if (previous.width !== 0) remember(session, next, onChange, saveTimer);
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
      remember(session, viewport, onChange, saveTimer);
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
    );
  }

  function resetZoom(): void {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    remember(session, zoomAt(session.doc.viewport, rect.width / 2, rect.height / 2, 1), onChange, saveTimer);
  }

  const cursor = axisCursor === 'vertical'
    ? ' is-axis-x'
    : axisCursor === 'horizontal'
      ? ' is-axis-y'
      : session.tool === 'pan'
        ? ' is-pan'
        : '';
  const live = session.liveSelection();

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
          axisDrag.current = null;
          setAxisCursor(null);
          setReadout(null);
          session.cancelGesture();
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
            remember(session, gestureViewport(start.viewport, start, gesture.midX, gesture.midY, gesture.distance), onChange, saveTimer);
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
          remember(session, viewport, onChange, saveTimer);
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
        panning.current = false;
        axisDrag.current = null;
        setAxisCursor(null);
        setReadout(null);
        session.cancelGesture();
        onChange();
      }}
    >
      <canvas ref={pixelRef} />
      <canvas ref={overlayRef} className="overlay" />
      {readout ? <p className="axis-readout">{readout}</p> : null}
      {live ? <p className="selection-readout">{selectionSizeLabel(live)}</p> : null}
      <div className="canvas-chrome" onPointerDown={(event) => event.stopPropagation()}>
        {session.tool === 'eraser' ? (
          <span className="eraser-size">
            <button type="button" className="icon-btn" aria-label={ru.eraserLess} title={ru.eraserLess} disabled={session.eraserSize <= 1} onClick={() => { session.eraserSize = Math.max(1, session.eraserSize - 1); onChange(); }}><Icon name="minus" /></button>
            <span className="step-value">{session.eraserSize}</span>
            <button type="button" className="icon-btn" aria-label={ru.eraserMore} title={ru.eraserMore} disabled={session.eraserSize >= 8} onClick={() => { session.eraserSize = Math.min(8, session.eraserSize + 1); onChange(); }}><Icon name="plus" /></button>
          </span>
        ) : null}
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
): void {
  session.doc = { ...session.doc, viewport };
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
  const image = renderRgba(session.doc, {
    grid: false,
    checker: session.doc.checkerVisible,
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
  pixelCtx.imageSmoothingEnabled = false;
  pixelCtx.clearRect(0, 0, rect.width, rect.height);
  const { viewport } = session.doc;
  const drawW = session.doc.width * viewport.cellSize * viewport.scale;
  const drawH = session.doc.height * viewport.cellSize * viewport.scale;
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
