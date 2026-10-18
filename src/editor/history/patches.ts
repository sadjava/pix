import { HISTORY_LIMIT, type CellPatch, type HistoryEntry, type PackedPatches, type PaletteColor } from '../../model/types.ts';

const BYTE_LIMIT = 400_000;

export interface HistoryStacks {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  notice: string | null;
}

export function clipHistory(stacks: HistoryStacks): HistoryStacks {
  return { undo: trim(stacks.undo), redo: trim(stacks.redo), notice: stacks.notice };
}

export function emptyHistory(): HistoryStacks {
  return { undo: [], redo: [], notice: null };
}

const PACK_FROM = 512;

export function packEntry(entry: HistoryEntry): HistoryEntry {
  if (entry.packed || entry.patches.length < PACK_FROM) return entry;
  const index = new Uint32Array(entry.patches.length);
  const before = new Uint16Array(entry.patches.length);
  const after = new Uint16Array(entry.patches.length);
  for (let i = 0; i < entry.patches.length; i += 1) {
    const patch = entry.patches[i];
    if (!patch) continue;
    index[i] = patch.index;
    before[i] = patch.before;
    after[i] = patch.after;
  }
  return {
    opNumber: entry.opNumber,
    type: entry.type,
    patches: [],
    packed: { index, before, after },
    paletteBefore: entry.paletteBefore,
    paletteAfter: entry.paletteAfter,
    slotBefore: entry.slotBefore,
    slotAfter: entry.slotAfter,
  };
}

export function pushHistory(stacks: HistoryStacks, entry: HistoryEntry): HistoryStacks {
  const undo = [...stacks.undo, packEntry(entry)];
  return { undo: trim(undo), redo: [], notice: stacks.notice };
}

export function undoHistory(
  cells: Uint16Array,
  stacks: HistoryStacks,
): { cells: Uint16Array; stacks: HistoryStacks } | null {
  const entry = stacks.undo[stacks.undo.length - 1];
  if (!entry) return null;
  const next = new Uint16Array(cells);
  paintEntry(next, entry, 'before');
  return {
    cells: next,
    stacks: { undo: stacks.undo.slice(0, -1), redo: [...stacks.redo, entry], notice: stacks.notice },
  };
}

export function redoHistory(
  cells: Uint16Array,
  stacks: HistoryStacks,
): { cells: Uint16Array; stacks: HistoryStacks } | null {
  const entry = stacks.redo[stacks.redo.length - 1];
  if (!entry) return null;
  const next = new Uint16Array(cells);
  paintEntry(next, entry, 'after');
  return {
    cells: next,
    stacks: { undo: [...stacks.undo, entry], redo: stacks.redo.slice(0, -1), notice: stacks.notice },
  };
}

function trim(undo: HistoryEntry[]): HistoryEntry[] {
  let next = undo.slice(-HISTORY_LIMIT);
  while (next.length > 1 && byteSize(next) > BYTE_LIMIT) next = next.slice(1);
  return next;
}

function byteSize(entries: HistoryEntry[]): number {
  let size = 0;
  for (const entry of entries) {
    if (entry.packed) size += entry.packed.index.byteLength + entry.packed.before.byteLength + entry.packed.after.byteLength;
    else size += entry.patches.length * 16;
  }
  return size;
}

function paintEntry(cells: Uint16Array, entry: HistoryEntry, direction: 'before' | 'after'): void {
  if (entry.packed) {
    const values = direction === 'before' ? entry.packed.before : entry.packed.after;
    for (let i = 0; i < entry.packed.index.length; i += 1) {
      const index = entry.packed.index[i] ?? 0;
      if (index >= 0 && index < cells.length) cells[index] = values[i] ?? 0;
    }
    return;
  }
  for (const patch of entry.patches) cells[patch.index] = direction === 'before' ? patch.before : patch.after;
}

export function parseHistory(raw: unknown): HistoryStacks {
  if (!raw || typeof raw !== 'object') {
    return { undo: [], redo: [], notice: 'История не прочитана. Рисунок сохранён.' };
  }
  const value = raw as { undo?: unknown; redo?: unknown };
  const undo = parseEntries(value.undo);
  const redo = parseEntries(value.redo);
  if (!undo || !redo) {
    return { undo: [], redo: [], notice: 'История не прочитана. Рисунок сохранён.' };
  }
  return { undo, redo, notice: null };
}

function parseEntries(raw: unknown): HistoryEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const entries: HistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const entry = item as { opNumber?: unknown; type?: unknown; patches?: unknown; packed?: unknown };
    if (typeof entry.opNumber !== 'number' || typeof entry.type !== 'string') return null;
    const palette = readPalettePair(item);
    const packed = readPacked(entry.packed);
    if (packed) {
      entries.push({ opNumber: entry.opNumber, type: entry.type, patches: [], packed, ...palette });
      continue;
    }
    if (!Array.isArray(entry.patches)) return null;
    const patches: CellPatch[] = [];
    for (const patch of entry.patches) {
      if (!patch || typeof patch !== 'object') return null;
      const cell = patch as { index?: unknown; before?: unknown; after?: unknown };
      if (typeof cell.index !== 'number' || typeof cell.before !== 'number' || typeof cell.after !== 'number') {
        return null;
      }
      patches.push({ index: cell.index, before: cell.before, after: cell.after });
    }
    entries.push({ opNumber: entry.opNumber, type: entry.type, patches, ...palette });
  }
  return entries;
}

function readPalettePair(raw: object): Pick<HistoryEntry, 'paletteBefore' | 'paletteAfter' | 'slotBefore' | 'slotAfter'> {
  const value = raw as { paletteBefore?: unknown; paletteAfter?: unknown; slotBefore?: unknown; slotAfter?: unknown };
  const paletteBefore = readPalette(value.paletteBefore);
  const paletteAfter = readPalette(value.paletteAfter);
  return {
    ...(paletteBefore ? { paletteBefore } : {}),
    ...(paletteAfter ? { paletteAfter } : {}),
    ...(typeof value.slotBefore === 'number' ? { slotBefore: value.slotBefore } : {}),
    ...(typeof value.slotAfter === 'number' ? { slotAfter: value.slotAfter } : {}),
  };
}

function readPalette(raw: unknown): PaletteColor[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const colors: PaletteColor[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return undefined;
    const color = item as { id?: unknown; name?: unknown; hex?: unknown };
    if (typeof color.id !== 'string' || typeof color.name !== 'string' || typeof color.hex !== 'string') return undefined;
    colors.push({ id: color.id, name: color.name, hex: color.hex });
  }
  return colors;
}

function readPacked(raw: unknown): PackedPatches | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { index?: unknown; before?: unknown; after?: unknown };
  const index = asTyped(value.index, Uint32Array);
  const before = asTyped(value.before, Uint16Array);
  const after = asTyped(value.after, Uint16Array);
  if (!index || !before || !after || index.length !== before.length || index.length !== after.length) return null;
  return { index, before, after };
}

function asTyped<T extends Uint16Array | Uint32Array>(raw: unknown, kind: { new (values: ArrayLike<number>): T; prototype: T }): T | null {
  if (raw instanceof kind) return raw;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'number')) return null;
  return new kind(raw);
}
