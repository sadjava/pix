import { ru } from '../../i18n/ru.ts';

/** 1-based description of an axis2 position. Even is a boundary, odd is a cell center. */
export function axisLabel(axis2: number, edge: number, vertical: boolean): string {
  const name = vertical ? ru.axisVertical : ru.axisHorizontal;
  if (axis2 % 2 === 0) {
    const n = axis2 / 2;
    if (n <= 0) return `${name}: ${ru.axisBefore}`;
    if (n >= edge) return `${name}: ${ru.axisAfter}`;
    return `${name}: ${ru.axisBetween} ${n} ${ru.axisAnd} ${n + 1}`;
  }
  return `${name}: ${ru.axisCellCenter} ${Math.ceil(axis2 / 2)}`;
}
