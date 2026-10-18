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

/**
 * Newest slot last in `order`.
 * A new hex is appended. It never rewrites an older slot, because those numbers are already on the canvas.
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
    return { palette, order: [...order.filter((item) => item !== slot), slot], slot };
  }
  const next = [...palette, { id: crypto.randomUUID(), name: normalized, hex: normalized }];
  const slot = slotOf(next.length - 1);
  return { palette: next, order: [...order, slot], slot };
}

export function revealColor(color: PaletteColor): PaletteColor {
  if (!color.hidden) return color;
  const next = { ...color };
  delete next.hidden;
  return next;
}

export function slotOf(paletteIndex: number): number {
  return paletteIndex + 1;
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
