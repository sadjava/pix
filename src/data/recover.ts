import { SCHEMA_VERSION, type JournalEntry, type ProjectDocument } from '../model/types.ts';
import { createDocument } from '../editor/canvas/grid.ts';
import { cellsToBytes } from '../export/json.ts';

export function recoverCells(cells: Uint16Array, revision: number, journal: readonly JournalEntry[]): Uint16Array {
  const next = new Uint16Array(cells);
  const pending = journal.filter((entry) => entry.opNumber > revision).sort((a, b) => a.opNumber - b.opNumber);
  for (const entry of pending) {
    for (const patch of entry.patches) {
      if (patch.index >= 0 && patch.index < next.length) next[patch.index] = patch.after;
    }
  }
  return next;
}

export type MigrateResult = { ok: true; doc: ProjectDocument } | { ok: false; error: string };

export function migrateDocument(raw: unknown): MigrateResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Запись повреждена. Исходные данные не изменены.' };
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion === SCHEMA_VERSION) return parseCurrent(record);
  if (record.schemaVersion === 0) return parseLegacy(record);
  return { ok: false, error: 'Неизвестная версия схемы. Сделайте резервную копию и не открывайте файл повторно как новую версию.' };
}

function parseCurrent(record: Record<string, unknown>): MigrateResult {
  const doc = documentFromParts(record);
  if (!doc) return { ok: false, error: 'Запись повреждена. Исходные данные не изменены.' };
  return { ok: true, doc };
}

function parseLegacy(record: Record<string, unknown>): MigrateResult {
  const doc = documentFromParts({ ...record, schemaVersion: SCHEMA_VERSION });
  if (!doc) return { ok: false, error: 'Старая запись не мигрирована. Исходные данные не изменены.' };
  return { ok: true, doc };
}

function documentFromParts(record: Record<string, unknown>): ProjectDocument | null {
  const width = record.width;
  const height = record.height;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  const cells = readCells(record.cells, width, height);
  if (!cells) return null;
  if (!Array.isArray(record.palette)) return null;
  const base = createDocument(width, height);
  const symmetry = record.symmetry;
  return {
    ...base,
    schemaVersion: SCHEMA_VERSION,
    palette: record.palette as ProjectDocument['palette'],
    cells,
    gridVisible: record.gridVisible !== false,
    checkerVisible: record.checkerVisible === true,
    checkerBlock: typeof record.checkerBlock === 'number' ? record.checkerBlock : 1,
    symmetry:
      symmetry && typeof symmetry === 'object'
        ? { ...base.symmetry, ...(symmetry as ProjectDocument['symmetry']) }
        : base.symmetry,
  };
}

function readCells(value: unknown, width: number, height: number): Uint16Array | null {
  const expected = width * height;
  if (value instanceof Uint16Array) return value.length === expected ? new Uint16Array(value) : null;
  if (value instanceof ArrayBuffer) {
    if (value.byteLength !== expected * 2) return null;
    return new Uint16Array(value.slice(0));
  }
  if (Array.isArray(value)) {
    if (value.length !== expected) return null;
    const cells = new Uint16Array(expected);
    for (let i = 0; i < expected; i++) {
      const cell = value[i];
      if (typeof cell !== 'number') return null;
      cells[i] = cell;
    }
    return cells;
  }
  return null;
}

export function cellsByteLength(cells: Uint16Array): number {
  return cellsToBytes(cells).byteLength;
}
