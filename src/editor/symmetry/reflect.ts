import type { Point, SymmetrySettings } from '../../model/types.ts';
import { inBounds } from '../canvas/grid.ts';

/** Mirror of column `c`. Even axis2 is a cell boundary, odd axis2 is a cell center. */
export function mirrorColumn(c: number, axisX2: number): number {
  return axisX2 - c - 1;
}

export function mirrorRow(r: number, axisY2: number): number {
  return axisY2 - r - 1;
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
