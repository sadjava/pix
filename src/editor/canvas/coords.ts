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
