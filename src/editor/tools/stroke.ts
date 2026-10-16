import type { CellPatch, Point } from '../../model/types.ts';
import { inBounds, indexOf } from '../canvas/grid.ts';

export function bresenham(x0: number, y0: number, x1: number, y1: number): Point[] {
  const points: Point[] = [];
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    points.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return points;
}

/** One patch per cell. `before` stays the value from before this stroke, even if the pointer revisits the cell. */
export function patchesForValues(
  cells: Uint16Array,
  width: number,
  height: number,
  points: readonly Point[],
  valueAt: (point: Point) => number,
): CellPatch[] {
  const map = new Map<number, CellPatch>();
  for (const point of points) {
    if (!inBounds(width, height, point.x, point.y)) continue;
    const index = indexOf(width, point.x, point.y);
    const value = valueAt(point);
    const existing = map.get(index);
    const before = existing ? existing.before : (cells[index] ?? 0);
    if (before === value) {
      if (existing) map.delete(index);
      continue;
    }
    map.set(index, { index, before, after: value });
  }
  return [...map.values()];
}

export function applyPatches(cells: Uint16Array, patches: readonly CellPatch[], direction: 'forward' | 'back'): void {
  for (const patch of patches) {
    cells[patch.index] = direction === 'forward' ? patch.after : patch.before;
  }
}
