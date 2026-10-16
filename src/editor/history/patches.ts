import { HISTORY_LIMIT, type CellPatch, type HistoryEntry } from '../../model/types.ts';

const BYTE_LIMIT = 1_500_000;

export interface HistoryStacks {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  notice: string | null;
}

export function emptyHistory(): HistoryStacks {
  return { undo: [], redo: [], notice: null };
}

export function pushHistory(stacks: HistoryStacks, entry: HistoryEntry): HistoryStacks {
  const undo = [...stacks.undo, entry];
  return { undo: trim(undo), redo: [], notice: stacks.notice };
}

export function undoHistory(
  cells: Uint16Array,
  stacks: HistoryStacks,
): { cells: Uint16Array; stacks: HistoryStacks } | null {
  const entry = stacks.undo[stacks.undo.length - 1];
  if (!entry) return null;
  const next = new Uint16Array(cells);
  for (const patch of entry.patches) next[patch.index] = patch.before;
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
  for (const patch of entry.patches) next[patch.index] = patch.after;
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
  return JSON.stringify(entries).length;
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
    const entry = item as { opNumber?: unknown; type?: unknown; patches?: unknown };
    if (typeof entry.opNumber !== 'number' || typeof entry.type !== 'string' || !Array.isArray(entry.patches)) {
      return null;
    }
    const patches: CellPatch[] = [];
    for (const patch of entry.patches) {
      if (!patch || typeof patch !== 'object') return null;
      const cell = patch as { index?: unknown; before?: unknown; after?: unknown };
      if (typeof cell.index !== 'number' || typeof cell.before !== 'number' || typeof cell.after !== 'number') {
        return null;
      }
      patches.push({ index: cell.index, before: cell.before, after: cell.after });
    }
    entries.push({ opNumber: entry.opNumber, type: entry.type, patches });
  }
  return entries;
}
