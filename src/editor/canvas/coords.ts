import type { Viewport } from '../../model/types.ts';

export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CellPoint {
  x: number;
  y: number;
}

/**
 * Map a pointer into cell coordinates.
 * Pointer events arrive in CSS pixels. The backing store is CSS size × DPR,
 * so DPR is part of the conversion and cancels out when the CSS box matches the rect.
 */
export function screenToCell(
  clientX: number,
  clientY: number,
  rect: ClientRect,
  viewport: Viewport,
  dpr: number,
): CellPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const backingX = (clientX - rect.left) * ((rect.width * safeDpr) / rect.width);
  const backingY = (clientY - rect.top) * ((rect.height * safeDpr) / rect.height);
  const cssX = backingX / safeDpr;
  const cssY = backingY / safeDpr;
  const worldX = (cssX - viewport.panX) / viewport.scale;
  const worldY = (cssY - viewport.panY) / viewport.scale;
  return {
    x: Math.floor(worldX / viewport.cellSize),
    y: Math.floor(worldY / viewport.cellSize),
  };
}

export function backingStoreSize(cssWidth: number, cssHeight: number, dpr: number): {
  width: number;
  height: number;
} {
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return {
    width: Math.max(1, Math.round(cssWidth * safeDpr)),
    height: Math.max(1, Math.round(cssHeight * safeDpr)),
  };
}

export function zoomAt(viewport: Viewport, cssX: number, cssY: number, nextScale: number): Viewport {
  const scale = clampScale(nextScale);
  const worldX = (cssX - viewport.panX) / viewport.scale;
  const worldY = (cssY - viewport.panY) / viewport.scale;
  return {
    ...viewport,
    scale,
    panX: cssX - worldX * scale,
    panY: cssY - worldY * scale,
  };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { ...viewport, panX: viewport.panX + dx, panY: viewport.panY + dy };
}

/** Keep some of the rug inside the view. A pan that misses the view entirely is fitted again. */
export function containViewport(
  viewport: Viewport,
  viewWidth: number,
  viewHeight: number,
  gridWidth: number,
  gridHeight: number,
): Viewport {
  const cellSize = viewport.cellSize > 0 ? viewport.cellSize : 16;
  if (!Number.isFinite(viewport.panX) || !Number.isFinite(viewport.panY) || viewWidth < 2 || viewHeight < 2) {
    return fitViewport(Math.max(viewWidth, 2), Math.max(viewHeight, 2), gridWidth, gridHeight, cellSize);
  }
  const scale = clampScale(viewport.scale);
  const drawW = gridWidth * cellSize * scale;
  const drawH = gridHeight * cellSize * scale;
  const outside = viewport.panX + drawW <= 0 || viewport.panY + drawH <= 0 || viewport.panX >= viewWidth || viewport.panY >= viewHeight;
  if (outside) return fitViewport(viewWidth, viewHeight, gridWidth, gridHeight, cellSize);
  return {
    ...viewport,
    scale,
    cellSize,
    panX: clampEdge(viewport.panX, drawW, viewWidth),
    panY: clampEdge(viewport.panY, drawH, viewHeight),
  };
}

function clampEdge(pan: number, draw: number, view: number): number {
  const margin = Math.min(64, Math.max(16, Math.min(draw, view) / 2));
  const lo = margin - draw;
  const hi = view - margin;
  if (lo > hi) return (view - draw) / 2;
  return Math.min(hi, Math.max(lo, pan));
}

/** Two fingers: a shared drag pans, a change in distance zooms around the first midpoint. */
export function gestureViewport(
  start: Viewport,
  origin: { midX: number; midY: number; distance: number },
  midX: number,
  midY: number,
  distance: number,
): Viewport {
  const ratio = origin.distance > 0 ? distance / origin.distance : 1;
  const scale = clampScale(start.scale * ratio);
  const worldX = (origin.midX - start.panX) / start.scale;
  const worldY = (origin.midY - start.panY) / start.scale;
  return { ...start, scale, panX: midX - worldX * scale, panY: midY - worldY * scale };
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(12, Math.max(0.05, scale));
}

/** Keep the world point under the view center stable when the CSS box changes (rotate/resize). */
export function resizeViewport(
  viewport: Viewport,
  previous: { width: number; height: number },
  next: { width: number; height: number },
): Viewport {
  const worldX = (previous.width / 2 - viewport.panX) / viewport.scale;
  const worldY = (previous.height / 2 - viewport.panY) / viewport.scale;
  return {
    ...viewport,
    panX: next.width / 2 - worldX * viewport.scale,
    panY: next.height / 2 - worldY * viewport.scale,
  };
}

export function fitViewport(
  viewWidth: number,
  viewHeight: number,
  gridWidth: number,
  gridHeight: number,
  cellSize: number,
): Viewport {
  const scale = clampScale(
    Math.min(viewWidth / (gridWidth * cellSize), viewHeight / (gridHeight * cellSize)) * 0.92,
  );
  return {
    cellSize,
    scale,
    panX: (viewWidth - gridWidth * cellSize * scale) / 2,
    panY: (viewHeight - gridHeight * cellSize * scale) / 2,
  };
}

/** Snap a cell-space position to an axis2 value (half-cell steps). */
export function axis2FromCellSpace(position: number): number {
  return Math.round(position * 2);
}

export function nudgeAxis(axis2: number, delta: number, maxEdge: number): number {
  const next = axis2 + delta;
  return Math.max(0, Math.min(maxEdge * 2, next));
}

export function snapAxis(axis2: number, mode: 'center' | 'edge'): number {
  const even = axis2 % 2 === 0;
  if (mode === 'edge') return even ? axis2 : axis2 - 1;
  return even ? axis2 + 1 : axis2;
}
