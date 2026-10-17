import type { CellPatch, ClipboardPayload, PaletteColor, Point } from '../../model/types.ts';
import { inBounds, indexOf } from '../canvas/grid.ts';
import { findOrAddHex } from '../palette/palette.ts';
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

/** Paste clipboard at origin. Colors match by HEX. Cells outside the grid are skipped. */
export function blitClipboard(
  cells: Uint16Array,
  gridWidth: number,
  gridHeight: number,
  palette: PaletteColor[],
  clipboard: ClipboardPayload,
  origin: Point,
): BlitResult {
  let nextPalette = palette;
  const slotMap = new Map<number, number>();
  let clipped = false;
  const patches: CellPatch[] = [];
  for (let y = 0; y < clipboard.height; y++) {
    for (let x = 0; x < clipboard.width; x++) {
      const srcSlot = clipboard.cells[indexOf(clipboard.width, x, y)] ?? 0;
      const gx = origin.x + x;
      const gy = origin.y + y;
      if (!inBounds(gridWidth, gridHeight, gx, gy)) {
        if (srcSlot !== 0) clipped = true;
        continue;
      }
      let destSlot = 0;
      if (srcSlot !== 0) {
        const mapped = slotMap.get(srcSlot);
        if (mapped !== undefined) destSlot = mapped;
        else {
          const color = clipboard.palette[srcSlot - 1];
          if (!color) destSlot = 0;
          else {
            const added = findOrAddHex(nextPalette, color.hex, color.name);
            nextPalette = added.palette;
            destSlot = added.slot;
          }
          slotMap.set(srcSlot, destSlot);
        }
      }
      const index = indexOf(gridWidth, gx, gy);
      const before = cells[index] ?? 0;
      if (before === destSlot) continue;
      patches.push({ index, before, after: destSlot });
    }
  }
  return { patches, palette: nextPalette, clipped };
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
