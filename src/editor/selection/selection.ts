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
