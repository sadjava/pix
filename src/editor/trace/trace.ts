/** One picture laid under the cells. The bitmap stays on this device. */
export interface TraceSprite {
  id: string;
  image: CanvasImageSource | null;
  blob: Blob;
  naturalWidth: number;
  naturalHeight: number;
  frame: TraceFrame;
  crop: SourceCrop;
  opacity: number;
}

/** A tracing picture in cell space. It is not part of the pixel grid. */
export interface TraceFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

/** Visible fraction of the source bitmap, each edge in 0..1. */
export interface SourceCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TraceGrip = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' | 'rotate' | 'body';

const MIN_EDGE = 4;
const MIN_CROP = 0.02;

export function fitFrame(canvasW: number, canvasH: number, imageW: number, imageH: number): TraceFrame {
  const aspect = imageW / Math.max(1, imageH);
  let width = Math.max(MIN_EDGE, canvasW * 0.7);
  let height = width / aspect;
  const maxH = Math.max(MIN_EDGE, canvasH * 0.7);
  if (height > maxH) {
    height = maxH;
    width = height * aspect;
  }
  return {
    x: (canvasW - width) / 2,
    y: (canvasH - height) / 2,
    width,
    height,
    rotation: 0,
  };
}

export function toLocal(frame: TraceFrame, cellX: number, cellY: number): { x: number; y: number } {
  const dx = cellX - (frame.x + frame.width / 2);
  const dy = cellY - (frame.y + frame.height / 2);
  const cos = Math.cos(frame.rotation);
  const sin = Math.sin(frame.rotation);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

export function toWorld(frame: TraceFrame, localX: number, localY: number): { x: number; y: number } {
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  const cos = Math.cos(frame.rotation);
  const sin = Math.sin(frame.rotation);
  return { x: cx + localX * cos - localY * sin, y: cy + localX * sin + localY * cos };
}

/** Topmost pictures should be tested last-to-first by the caller. */
export function gripAt(frame: TraceFrame, cellX: number, cellY: number, slop: number): TraceGrip | null {
  const local = toLocal(frame, cellX, cellY);
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  const reach = Math.max(slop, 0.5);
  if (Math.hypot(local.x, local.y - (-hh - reach * 1.8)) <= reach) return 'rotate';
  const corners: [TraceGrip, number, number][] = [
    ['nw', -hw, -hh],
    ['ne', hw, -hh],
    ['sw', -hw, hh],
    ['se', hw, hh],
  ];
  for (const [grip, gx, gy] of corners) {
    if (Math.hypot(local.x - gx, local.y - gy) <= reach) return grip;
  }
  if (Math.abs(local.y + hh) <= reach && Math.abs(local.x) <= hw + reach) return 'n';
  if (Math.abs(local.y - hh) <= reach && Math.abs(local.x) <= hw + reach) return 's';
  if (Math.abs(local.x + hw) <= reach && Math.abs(local.y) <= hh + reach) return 'w';
  if (Math.abs(local.x - hw) <= reach && Math.abs(local.y) <= hh + reach) return 'e';
  if (Math.abs(local.x) <= hw && Math.abs(local.y) <= hh) return 'body';
  return null;
}

export function placeTrace(
  frame: TraceFrame,
  crop: SourceCrop,
  grip: TraceGrip,
  cellX: number,
  cellY: number,
  fromX: number,
  fromY: number,
): { frame: TraceFrame; crop: SourceCrop } {
  if (grip === 'body') return { frame: { ...frame, x: frame.x + cellX - fromX, y: frame.y + cellY - fromY }, crop };
  if (grip === 'rotate') return { frame: { ...frame, rotation: Math.atan2(cellY - (frame.y + frame.height / 2), cellX - (frame.x + frame.width / 2)) + Math.PI / 2 }, crop };
  if (grip === 'n' || grip === 's' || grip === 'e' || grip === 'w') return cropEdge(frame, crop, grip, cellX, cellY);
  return { frame: resizeFrame(frame, grip, cellX, cellY), crop };
}

function resizeFrame(frame: TraceFrame, grip: 'nw' | 'ne' | 'sw' | 'se', cellX: number, cellY: number): TraceFrame {
  const local = toLocal(frame, cellX, cellY);
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  const ux = grip.includes('e') ? 1 : -1;
  const uy = grip.includes('s') ? 1 : -1;
  const anchor = { x: -ux * hw, y: -uy * hh };
  const spanX = Math.max(MIN_EDGE, (local.x - anchor.x) * ux);
  const spanY = Math.max(MIN_EDGE, (local.y - anchor.y) * uy);
  const scale = Math.max(spanX / frame.width, spanY / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  const world = toWorld(frame, anchor.x + (ux * width) / 2, anchor.y + (uy * height) / 2);
  return { x: world.x - width / 2, y: world.y - height / 2, width, height, rotation: frame.rotation };
}

function cropEdge(
  frame: TraceFrame,
  crop: SourceCrop,
  grip: 'n' | 's' | 'e' | 'w',
  cellX: number,
  cellY: number,
): { frame: TraceFrame; crop: SourceCrop } {
  const local = toLocal(frame, cellX, cellY);
  const scaleX = frame.width / crop.width;
  const scaleY = frame.height / crop.height;
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  const next = { ...crop };
  let width = frame.width;
  let height = frame.height;
  let anchorX = 0;
  let anchorY = 0;
  if (grip === 'e' || grip === 'w') {
    const fixed = grip === 'e' ? -hw : hw;
    const span = Math.max(MIN_EDGE, grip === 'e' ? local.x - fixed : fixed - local.x);
    const raw = span / scaleX;
    if (grip === 'e') {
      next.width = clamp(raw, MIN_CROP, 1 - crop.x);
      width = next.width * scaleX;
      anchorX = -hw + width / 2;
    } else {
      const right = crop.x + crop.width;
      next.width = clamp(raw, MIN_CROP, right);
      next.x = right - next.width;
      width = next.width * scaleX;
      anchorX = hw - width / 2;
    }
  } else {
    const fixed = grip === 's' ? -hh : hh;
    const span = Math.max(MIN_EDGE, grip === 's' ? local.y - fixed : fixed - local.y);
    const raw = span / scaleY;
    if (grip === 's') {
      next.height = clamp(raw, MIN_CROP, 1 - crop.y);
      height = next.height * scaleY;
      anchorY = -hh + height / 2;
    } else {
      const bottom = crop.y + crop.height;
      next.height = clamp(raw, MIN_CROP, bottom);
      next.y = bottom - next.height;
      height = next.height * scaleY;
      anchorY = hh - height / 2;
    }
  }
  const world = toWorld(frame, anchorX, anchorY);
  return {
    crop: next,
    frame: { x: world.x - width / 2, y: world.y - height / 2, width, height, rotation: frame.rotation },
  };
}

function clamp(value: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.max(lo, Math.min(hi, value));
}
