import { inBounds, indexOf } from '../canvas/grid.ts';

/**
 * Iterative 4-connected flood fill.
 * Single seen-array and index queue without per-cell object allocations.
 */
export function floodIndices(cells: Uint16Array, width: number, height: number, x: number, y: number): number[] {
  if (!inBounds(width, height, x, y)) return [];
  const start = indexOf(width, x, y);
  const target = cells[start] ?? 0;
  const total = cells.length;
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  queue[tail++] = start;
  seen[start] = 1;

  while (head < tail) {
    const index = queue[head++]!;
    const cx = index % width;
    const cy = Math.floor(index / width);

    // Right: cx + 1, cy
    if (cx + 1 < width) {
      const next = index + 1;
      if (!seen[next] && (cells[next] ?? 0) === target) {
        seen[next] = 1;
        queue[tail++] = next;
      }
    }
    // Left: cx - 1, cy
    if (cx > 0) {
      const next = index - 1;
      if (!seen[next] && (cells[next] ?? 0) === target) {
        seen[next] = 1;
        queue[tail++] = next;
      }
    }
    // Down: cx, cy + 1
    if (cy + 1 < height) {
      const next = index + width;
      if (!seen[next] && (cells[next] ?? 0) === target) {
        seen[next] = 1;
        queue[tail++] = next;
      }
    }
    // Up: cx, cy - 1
    if (cy > 0) {
      const next = index - width;
      if (!seen[next] && (cells[next] ?? 0) === target) {
        seen[next] = 1;
        queue[tail++] = next;
      }
    }
  }

  const out: number[] = new Array(tail);
  for (let i = 0; i < tail; i++) {
    out[i] = queue[i]!;
  }
  return out;
}
