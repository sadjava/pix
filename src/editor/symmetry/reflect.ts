import type { Point, SymmetrySettings } from '../../model/types.ts';
import { inBounds } from '../canvas/grid.ts';

/** Mirror of column `c`. Even axis2 is a cell boundary, odd axis2 is a cell center. */
export function mirrorColumn(c: number, axisX2: number): number {
  return axisX2 - c - 1;
}

export function mirrorRow(r: number, axisY2: number): number {
  return axisY2 - r - 1;
}

/** The point plus its copies across the active axes. The point on an axis is not repeated. */
export function symmetryCopies(point: Point, symmetry: SymmetrySettings): Point[] {
  const copies = [point];
  const vertical = symmetry.mode === 'vertical' || symmetry.mode === 'both';
  const horizontal = symmetry.mode === 'horizontal' || symmetry.mode === 'both';
  const mx = mirrorColumn(point.x, symmetry.axisX2);
  const my = mirrorRow(point.y, symmetry.axisY2);
  if (vertical && mx !== point.x) copies.push({ x: mx, y: point.y });
  if (horizontal && my !== point.y) copies.push({ x: point.x, y: my });
  if (vertical && horizontal && (mx !== point.x || my !== point.y)) copies.push({ x: mx, y: my });
  return copies;
}

export function reflectPoints(
  points: readonly Point[],
  symmetry: SymmetrySettings,
  width: number,
  height: number,
): Point[] {
  const unique = new Map<string, Point>();
  const add = (x: number, y: number) => {
    if (!inBounds(width, height, x, y)) return;
    unique.set(`${x},${y}`, { x, y });
  };
  const vertical = symmetry.mode === 'vertical' || symmetry.mode === 'both';
  const horizontal = symmetry.mode === 'horizontal' || symmetry.mode === 'both';
  for (const point of points) {
    add(point.x, point.y);
    const mx = mirrorColumn(point.x, symmetry.axisX2);
    const my = mirrorRow(point.y, symmetry.axisY2);
    if (vertical) add(mx, point.y);
    if (horizontal) add(point.x, my);
    if (vertical && horizontal) add(mx, my);
  }
  return [...unique.values()];
}
