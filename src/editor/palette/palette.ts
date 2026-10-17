import type { PaletteColor } from '../../model/types.ts';

const HEX = /^#[0-9a-fA-F]{6}$/;

export function normalizeHex(hex: string): string | null {
  const value = hex.trim();
  if (!HEX.test(value)) return null;
  return value.toLowerCase();
}

export function defaultPalette(): PaletteColor[] {
  return [{ id: 'ink', name: 'Чернь', hex: '#1a1614' }];
}

const RECENT_COLORS = 8;

/**
 * Recent colors, newest at the end of `order` (slot numbers).
 * ponytail: the list stops at 8. A new color overwrites the oldest slot's hex, so cell numbers stay put.
 */
export function pickRecentColor(
  palette: PaletteColor[],
  order: readonly number[],
  hex: string,
): { palette: PaletteColor[]; order: number[]; slot: number } | null {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  const existing = palette.findIndex((color) => color.hex === normalized);
  if (existing >= 0) {
    const slot = slotOf(existing);
    return { palette, order: [...order.filter((item) => item !== slot), slot].slice(-RECENT_COLORS), slot };
  }
  if (palette.length < RECENT_COLORS) {
    const next = [...palette, { id: crypto.randomUUID(), name: normalized, hex: normalized }];
    const slot = slotOf(next.length - 1);
    return { palette: next, order: [...order, slot].slice(-RECENT_COLORS), slot };
  }
  const oldest = order[0] ?? 1;
  const index = paletteIndexOf(oldest);
  const current = palette[index];
  if (!current) return null;
  const next = palette.map((color, i) => (i === index ? { ...color, name: normalized, hex: normalized } : color));
  return { palette: next, order: [...order.slice(1), oldest], slot: oldest };
}

export function slotOf(paletteIndex: number): number {
  return paletteIndex + 1;
}

export function paletteIndexOf(slot: number): number {
  return slot - 1;
}

export function colorUsed(cells: Uint16Array, slot: number): boolean {
  for (let i = 0; i < cells.length; i++) if (cells[i] === slot) return true;
  return false;
}

export function addColor(palette: PaletteColor[], color: PaletteColor): PaletteColor[] {
  return [...palette, color];
}

export function renameColor(
  palette: PaletteColor[],
  id: string,
  patch: { name?: string; hex?: string },
): PaletteColor[] {
  return palette.map((color) => {
    if (color.id !== id) return color;
    const hex = patch.hex === undefined ? color.hex : normalizeHex(patch.hex);
    if (patch.hex !== undefined && !hex) return color;
    return { ...color, name: patch.name ?? color.name, hex: hex ?? color.hex };
  });
}

/** Drop a palette entry and remap higher slots down by one. `replacement` is the slot written into cells that used the removed color. */
export function removeColor(
  palette: PaletteColor[],
  cells: Uint16Array,
  paletteIndex: number,
  replacementSlot: number,
): { palette: PaletteColor[]; cells: Uint16Array } | null {
  if (paletteIndex < 0 || paletteIndex >= palette.length) return null;
  const removedSlot = slotOf(paletteIndex);
  if (replacementSlot === removedSlot) return null;
  const mappedReplacement = replacementSlot > removedSlot ? replacementSlot - 1 : replacementSlot;
  const nextCells = new Uint16Array(cells);
  for (let i = 0; i < nextCells.length; i++) {
    const slot = nextCells[i] ?? 0;
    if (slot === 0) continue;
    if (slot === removedSlot) nextCells[i] = mappedReplacement;
    else if (slot > removedSlot) nextCells[i] = slot - 1;
  }
  const nextPalette = palette.filter((_, index) => index !== paletteIndex);
  return { palette: nextPalette, cells: nextCells };
}

export function findOrAddHex(palette: PaletteColor[], hex: string, name: string): {
  palette: PaletteColor[];
  slot: number;
} {
  const normalized = normalizeHex(hex);
  if (!normalized) return { palette, slot: 0 };
  const existing = palette.findIndex((color) => color.hex === normalized);
  if (existing >= 0) return { palette, slot: slotOf(existing) };
  const color = { id: `c-${palette.length}-${normalized.slice(1)}`, name, hex: normalized };
  const next = [...palette, color];
  return { palette: next, slot: slotOf(next.length - 1) };
}
