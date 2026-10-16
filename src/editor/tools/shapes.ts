import type { Point } from '../../model/types.ts';
import { bresenham } from './stroke.ts';

export function uniquePoints(points: readonly Point[]): Point[] {
  const map = new Map<string, Point>();
  for (const point of points) map.set(`${point.x},${point.y}`, point);
  return [...map.values()];
}

export function lineCells(a: Point, b: Point): Point[] {
  return bresenham(a.x, a.y, b.x, b.y);
}

export function circleCells(center: Point, radius: number): Point[] {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return [{ x: center.x, y: center.y }];
  const pts: Point[] = [];
  let x = r;
  let y = 0;
  let err = 1 - r;
  while (x >= y) {
    pts.push(
      { x: center.x + x, y: center.y + y },
      { x: center.x + y, y: center.y + x },
      { x: center.x - y, y: center.y + x },
      { x: center.x - x, y: center.y + y },
      { x: center.x - x, y: center.y - y },
      { x: center.x - y, y: center.y - x },
      { x: center.x + y, y: center.y - x },
      { x: center.x + x, y: center.y - y },
    );
    y += 1;
    if (err < 0) err += 2 * y + 1;
    else {
      x -= 1;
      err += 2 * (y - x) + 1;
    }
  }
  return uniquePoints(pts);
}

export function rectOutline(a: Point, b: Point): Point[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const pts: Point[] = [];
  for (let x = x0; x <= x1; x++) {
    pts.push({ x, y: y0 });
    if (y1 !== y0) pts.push({ x, y: y1 });
  }
  for (let y = y0 + 1; y < y1; y++) {
    pts.push({ x: x0, y });
    if (x1 !== x0) pts.push({ x: x1, y });
  }
  return pts;
}

/** Diamond with vertices on the horizontal and vertical axes. Radius 0 is the center cell. */
export function diamondCells(center: Point, radius: number): Point[] {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return [{ x: center.x, y: center.y }];
  const pts: Point[] = [];
  for (let dx = -r; dx <= r; dx++) {
    const dy = r - Math.abs(dx);
    pts.push({ x: center.x + dx, y: center.y + dy });
    if (dy !== 0) pts.push({ x: center.x + dx, y: center.y - dy });
  }
  return pts;
}

export function radiusOf(a: Point, b: Point): number {
  return Math.round(Math.hypot(b.x - a.x, b.y - a.y));
}

export function inclusiveSize(a: Point, b: Point): { width: number; height: number } {
  return { width: Math.abs(b.x - a.x) + 1, height: Math.abs(b.y - a.y) + 1 };
}
