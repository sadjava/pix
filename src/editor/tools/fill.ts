import { inBounds, indexOf } from '../canvas/grid.ts';

/**
 * Iterative 4-connected flood fill.
 * ponytail: one seen-array the size of the grid; fine through 500×500, switch to a tiled queue if larger canvases become common.
 */
export function floodIndices(cells: Uint16Array, width: number, height: number, x: number, y: number): number[] {
  if (!inBounds(width, height, x, y)) return [];
  const start = indexOf(width, x, y);
  const target = cells[start] ?? 0;
  const seen = new Uint8Array(cells.length);
  const qx = new Int32Array(cells.length);
  const qy = new Int32Array(cells.length);
  let head = 0;
  let tail = 0;
  qx[tail] = x;
  qy[tail] = y;
  tail += 1;
  seen[start] = 1;
  const out: number[] = [];
  while (head < tail) {
    const cx = qx[head] ?? 0;
    const cy = qy[head] ?? 0;
    head += 1;
    const index = indexOf(width, cx, cy);
    if ((cells[index] ?? 0) !== target) continue;
    out.push(index);
    const neighbors = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ];
    for (const pair of neighbors) {
      const nx = pair[0] ?? 0;
      const ny = pair[1] ?? 0;
      if (!inBounds(width, height, nx, ny)) continue;
      const next = indexOf(width, nx, ny);
      if (seen[next] || (cells[next] ?? 0) !== target) continue;
      seen[next] = 1;
      qx[tail] = nx;
      qy[tail] = ny;
      tail += 1;
    }
  }
  return out;
}
