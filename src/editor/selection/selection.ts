import type { CellPatch, ClipboardPayload, PaletteColor, Point, SymmetrySettings } from '../../model/types.ts';
import { inBounds, indexOf } from '../canvas/grid.ts';
import { findOrAddHex } from '../palette/palette.ts';
import { symmetryCopies } from '../symmetry/reflect.ts';
import { inclusiveSize } from '../tools/shapes.ts';

export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SelectionHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

/** Move one edge or corner. The opposite side stays put, and the rect stays on the canvas. */
export function resizeSelectionRect(
  origin: SelectionRect,
  handle: SelectionHandle,
  cell: Point,
  gridWidth: number,
  gridHeight: number,
): SelectionRect {
  let x0 = origin.x;
  let y0 = origin.y;
  let x1 = origin.x + origin.width - 1;
  let y1 = origin.y + origin.height - 1;
  if (handle.includes('w')) x0 = cell.x;
  if (handle.includes('e')) x1 = cell.x;
  if (handle.includes('n')) y0 = cell.y;
  if (handle.includes('s')) y1 = cell.y;
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (y0 > y1) [y0, y1] = [y1, y0];
  x0 = Math.max(0, Math.min(gridWidth - 1, x0));
  x1 = Math.max(0, Math.min(gridWidth - 1, x1));
  y0 = Math.max(0, Math.min(gridHeight - 1, y0));
  y1 = Math.max(0, Math.min(gridHeight - 1, y1));
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

const QUARTER = Math.PI / 2;
const SNAP_TURN = (6 * Math.PI) / 180;

/** Pull a free angle onto a right angle when the finger is close, so 90° steps stay exact. */
export function snapRotation(radians: number): number {
  const steps = Math.round(radians / QUARTER);
  const snapped = steps * QUARTER;
  return Math.abs(radians - snapped) <= SNAP_TURN ? snapped : radians;
}

/**
 * Rotate the copied stitches around the selection center.
 * Right angles are a permutation of the cells, so the picture is copied, not resampled.
 * Any other angle samples the nearest source cell and never blends two colors.
 */
export function rotateRegion(
  cells: Uint16Array,
  gridWidth: number,
  gridHeight: number,
  source: SelectionRect,
  sourceCells: Uint16Array,
  radians: number,
): { patches: CellPatch[]; rect: SelectionRect } {
  const turns = quarterTurns(radians);
  const dest = turns === null
    ? freeBounds(source, radians, gridWidth, gridHeight)
    : placeRect(quarterRect(source, turns), gridWidth, gridHeight);
  const after = new Map<number, number>();
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const gx = source.x + x;
      const gy = source.y + y;
      if (!inBounds(gridWidth, gridHeight, gx, gy)) continue;
      after.set(indexOf(gridWidth, gx, gy), 0);
    }
  }
  if (turns !== null) {
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const local = turnLocal(x, y, source.width, source.height, turns);
        const gx = dest.x + local.x;
        const gy = dest.y + local.y;
        if (!inBounds(gridWidth, gridHeight, gx, gy)) continue;
        after.set(indexOf(gridWidth, gx, gy), sourceCells[y * source.width + x] ?? 0);
      }
    }
  } else {
    const cx = source.x + source.width / 2;
    const cy = source.y + source.height / 2;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    for (let gy = dest.y; gy < dest.y + dest.height; gy += 1) {
      for (let gx = dest.x; gx < dest.x + dest.width; gx += 1) {
        const dx = gx + 0.5 - cx;
        const dy = gy + 0.5 - cy;
        const sx = cx + dx * cos + dy * sin;
        const sy = cy - dx * sin + dy * cos;
        const lx = Math.floor(sx - source.x);
        const ly = Math.floor(sy - source.y);
        if (lx < 0 || ly < 0 || lx >= source.width || ly >= source.height) continue;
        if (!inBounds(gridWidth, gridHeight, gx, gy)) continue;
        after.set(indexOf(gridWidth, gx, gy), sourceCells[ly * source.width + lx] ?? 0);
      }
    }
  }
  const patches: CellPatch[] = [];
  for (const [index, value] of after) {
    const before = cells[index] ?? 0;
    if (before !== value) patches.push({ index, before, after: value });
  }
  return { patches, rect: dest };
}

function quarterTurns(radians: number): 0 | 1 | 2 | 3 | null {
  const steps = Math.round(radians / QUARTER);
  if (Math.abs(radians - steps * QUARTER) > 1e-4) return null;
  return ((steps % 4) + 4) % 4 as 0 | 1 | 2 | 3;
}

function turnLocal(x: number, y: number, width: number, height: number, turns: 0 | 1 | 2 | 3): { x: number; y: number } {
  if (turns === 1) return { x: height - 1 - y, y: x };
  if (turns === 2) return { x: width - 1 - x, y: height - 1 - y };
  if (turns === 3) return { x: y, y: width - 1 - x };
  return { x, y };
}

function quarterRect(source: SelectionRect, turns: 0 | 1 | 2 | 3): SelectionRect {
  if (turns === 0 || turns === 2) return { x: source.x, y: source.y, width: source.width, height: source.height };
  // trunc, not round: half-pixels round asymmetrically and a 3×2 block would walk across the canvas.
  return {
    x: source.x + Math.trunc((source.width - source.height) / 2),
    y: source.y + Math.trunc((source.height - source.width) / 2),
    width: source.height,
    height: source.width,
  };
}

function freeBounds(source: SelectionRect, radians: number, gridWidth: number, gridHeight: number): SelectionRect {
  const cx = source.x + source.width / 2;
  const cy = source.y + source.height / 2;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners = [
    [source.x, source.y],
    [source.x + source.width, source.y],
    [source.x + source.width, source.y + source.height],
    [source.x, source.y + source.height],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of corners) {
    const dx = (px ?? 0) - cx;
    const dy = (py ?? 0) - cy;
    const rx = cx + dx * cos - dy * sin;
    const ry = cy + dx * sin + dy * cos;
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  }
  return clampSelection(
    { x: Math.floor(minX), y: Math.floor(minY), width: Math.ceil(maxX) - Math.floor(minX), height: Math.ceil(maxY) - Math.floor(minY) },
    gridWidth,
    gridHeight,
  );
}

function placeRect(rect: SelectionRect, gridWidth: number, gridHeight: number): SelectionRect {
  const width = Math.min(rect.width, gridWidth);
  const height = Math.min(rect.height, gridHeight);
  return {
    x: Math.max(0, Math.min(gridWidth - width, rect.x)),
    y: Math.max(0, Math.min(gridHeight - height, rect.y)),
    width,
    height,
  };
}

function clampSelection(rect: SelectionRect, gridWidth: number, gridHeight: number): SelectionRect {
  const x0 = Math.max(0, Math.min(gridWidth - 1, rect.x));
  const y0 = Math.max(0, Math.min(gridHeight - 1, rect.y));
  const x1 = Math.max(x0, Math.min(gridWidth - 1, rect.x + rect.width - 1));
  const y1 = Math.max(y0, Math.min(gridHeight - 1, rect.y + rect.height - 1));
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Nearest-neighbor scale of a copied region. Cells left behind become empty. */
export function scaleRegion(
  cells: Uint16Array,
  gridWidth: number,
  gridHeight: number,
  source: SelectionRect,
  sourceCells: Uint16Array,
  dest: SelectionRect,
): CellPatch[] {
  const after = new Map<number, number>();
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const gx = source.x + x;
      const gy = source.y + y;
      if (!inBounds(gridWidth, gridHeight, gx, gy)) continue;
      after.set(indexOf(gridWidth, gx, gy), 0);
    }
  }
  for (let y = 0; y < dest.height; y += 1) {
    for (let x = 0; x < dest.width; x += 1) {
      const gx = dest.x + x;
      const gy = dest.y + y;
      if (!inBounds(gridWidth, gridHeight, gx, gy)) continue;
      const u = Math.min(source.width - 1, Math.floor(((x + 0.5) * source.width) / dest.width));
      const v = Math.min(source.height - 1, Math.floor(((y + 0.5) * source.height) / dest.height));
      after.set(indexOf(gridWidth, gx, gy), sourceCells[v * source.width + u] ?? 0);
    }
  }
  const patches: CellPatch[] = [];
  for (const [index, value] of after) {
    const before = cells[index] ?? 0;
    if (before !== value) patches.push({ index, before, after: value });
  }
  return patches;
}

export function normalizeSelection(a: Point, b: Point): SelectionRect {
  const size = inclusiveSize(a, b);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: size.width, height: size.height };
}

export function extractRegion(
  cells: Uint16Array,
  gridWidth: number,
  gridHeight: number,
  rect: SelectionRect,
  palette: PaletteColor[],
): ClipboardPayload {
  const out = new Uint16Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const gx = rect.x + x;
      const gy = rect.y + y;
      out[indexOf(rect.width, x, y)] = inBounds(gridWidth, gridHeight, gx, gy)
        ? (cells[indexOf(gridWidth, gx, gy)] ?? 0)
        : 0;
    }
  }
  return { schemaVersion: 1, width: rect.width, height: rect.height, cells: out, palette };
}

export function clearRegion(
  cells: Uint16Array,
  gridWidth: number,
  gridHeight: number,
  rect: SelectionRect,
): CellPatch[] {
  const patches: CellPatch[] = [];
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const gx = rect.x + x;
      const gy = rect.y + y;
      if (!inBounds(gridWidth, gridHeight, gx, gy)) continue;
      const index = indexOf(gridWidth, gx, gy);
      const before = cells[index] ?? 0;
      if (before === 0) continue;
      patches.push({ index, before, after: 0 });
    }
  }
  return patches;
}

export interface BlitResult {
  patches: CellPatch[];
  palette: PaletteColor[];
  clipped: boolean;
}

/** Paste clipboard at origin. Colors match by HEX. Active symmetry stamps the same stitches across the axes. */
export function blitClipboard(
  cells: Uint16Array,
  gridWidth: number,
  gridHeight: number,
  palette: PaletteColor[],
  clipboard: ClipboardPayload,
  origin: Point,
  symmetry: SymmetrySettings,
): BlitResult {
  let nextPalette = palette;
  const slotMap = new Map<number, number>();
  const desired = new Map<number, number>();
  let clipped = false;
  for (let y = 0; y < clipboard.height; y++) {
    for (let x = 0; x < clipboard.width; x++) {
      const srcSlot = clipboard.cells[indexOf(clipboard.width, x, y)] ?? 0;
      let destSlot = 0;
      if (srcSlot !== 0) {
        const mapped = slotMap.get(srcSlot);
        if (mapped !== undefined) destSlot = mapped;
        else {
          const color = clipboard.palette[srcSlot - 1];
          if (color) {
            const added = findOrAddHex(nextPalette, color.hex, color.name);
            nextPalette = added.palette;
            destSlot = added.slot;
          }
          slotMap.set(srcSlot, destSlot);
        }
      }
      for (const dest of symmetryCopies({ x: origin.x + x, y: origin.y + y }, symmetry)) {
        if (!inBounds(gridWidth, gridHeight, dest.x, dest.y)) {
          if (srcSlot !== 0) clipped = true;
          continue;
        }
        desired.set(indexOf(gridWidth, dest.x, dest.y), destSlot);
      }
    }
  }
  const patches: CellPatch[] = [];
  for (const [index, destSlot] of desired) {
    const before = cells[index] ?? 0;
    if (before === destSlot) continue;
    patches.push({ index, before, after: destSlot });
  }
  return { patches, palette: nextPalette, clipped };
}

/** Mirror the stitches inside the selection. The rectangle stays where it is. */
export function flipRegion(
  cells: Uint16Array,
  gridWidth: number,
  gridHeight: number,
  rect: SelectionRect,
  axis: 'horizontal' | 'vertical',
): CellPatch[] {
  const after = new Map<number, number>();
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const gx = rect.x + x;
      const gy = rect.y + y;
      if (!inBounds(gridWidth, gridHeight, gx, gy)) continue;
      after.set(indexOf(gridWidth, gx, gy), 0);
    }
  }
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const sx = rect.x + x;
      const sy = rect.y + y;
      const value = inBounds(gridWidth, gridHeight, sx, sy) ? (cells[indexOf(gridWidth, sx, sy)] ?? 0) : 0;
      const dx = axis === 'horizontal' ? rect.x + rect.width - 1 - x : sx;
      const dy = axis === 'vertical' ? rect.y + rect.height - 1 - y : sy;
      if (!inBounds(gridWidth, gridHeight, dx, dy)) continue;
      after.set(indexOf(gridWidth, dx, dy), value);
    }
  }
  const patches: CellPatch[] = [];
  for (const [index, value] of after) {
    const before = cells[index] ?? 0;
    if (before !== value) patches.push({ index, before, after: value });
  }
  return patches;
}

/**
 * Move a region by (dx, dy) as one patch list against the original cells.
 * Overlap uses the original value as `before`.
 */
export function moveRegion(
  cells: Uint16Array,
  gridWidth: number,
  gridHeight: number,
  rect: SelectionRect,
  dx: number,
  dy: number,
): { patches: CellPatch[]; clipped: boolean; rect: SelectionRect } {
  const original = new Uint16Array(cells);
  const desired = new Map<number, number>();
  let clipped = false;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const sx = rect.x + x;
      const sy = rect.y + y;
      if (!inBounds(gridWidth, gridHeight, sx, sy)) continue;
      const value = original[indexOf(gridWidth, sx, sy)] ?? 0;
      const tx = sx + dx;
      const ty = sy + dy;
      if (!inBounds(gridWidth, gridHeight, tx, ty)) {
        if (value !== 0) clipped = true;
        continue;
      }
      desired.set(indexOf(gridWidth, tx, ty), value);
    }
  }
  const cleared = new Set<number>();
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const sx = rect.x + x;
      const sy = rect.y + y;
      if (!inBounds(gridWidth, gridHeight, sx, sy)) continue;
      cleared.add(indexOf(gridWidth, sx, sy));
    }
  }
  const indexes = new Set<number>([...cleared, ...desired.keys()]);
  const patches: CellPatch[] = [];
  for (const index of indexes) {
    const before = original[index] ?? 0;
    const after = desired.has(index) ? (desired.get(index) ?? 0) : cleared.has(index) ? 0 : before;
    if (before !== after) patches.push({ index, before, after });
  }
  return {
    patches,
    clipped,
    rect: { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height },
  };
}
