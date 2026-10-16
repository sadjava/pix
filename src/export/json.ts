import { MAX_EDGE, SCHEMA_VERSION, type PaletteColor, type ProjectDocument, type SymmetryMode, type SymmetrySettings } from '../model/types.ts';
import { normalizeHex } from '../editor/palette/palette.ts';

export interface ProjectFile {
  schemaVersion: number;
  projectId: string;
  name: string;
  width: number;
  height: number;
  palette: PaletteColor[];
  cells: string;
  gridVisible: boolean;
  checkerVisible: boolean;
  checkerBlock: number;
  symmetry: SymmetrySettings;
}

const FORBIDDEN = ['token', 'access_token', 'refresh_token', 'service_role', 'authorization', 'password', 'storageobjectpath'];

export function cellsToBase64(cells: Uint16Array): string {
  const bytes = cellsToBytes(cells);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToCells(value: string, width: number, height: number): Uint16Array | null {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  if (binary.length !== width * height * 2) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const cells = new Uint16Array(width * height);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < cells.length; i++) cells[i] = view.getUint16(i * 2, true);
  return cells;
}

export function cellsToBytes(cells: Uint16Array): Uint8Array {
  const bytes = new Uint8Array(cells.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < cells.length; i++) view.setUint16(i * 2, cells[i] ?? 0, true);
  return bytes;
}

export function exportProjectFile(projectId: string, name: string, doc: ProjectDocument): string {
  const file: ProjectFile = {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    name,
    width: doc.width,
    height: doc.height,
    palette: doc.palette.map((color) => ({ id: color.id, name: color.name, hex: color.hex })),
    cells: cellsToBase64(doc.cells),
    gridVisible: doc.gridVisible,
    checkerVisible: doc.checkerVisible,
    checkerBlock: doc.checkerBlock,
    symmetry: { ...doc.symmetry },
  };
  return canonicalJson(file);
}

export function canonicalJson(file: ProjectFile): string {
  return JSON.stringify(file);
}

export type ImportResult = { ok: true; file: ProjectFile; cells: Uint16Array } | { ok: false; error: string };

export function parseProjectFile(text: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Файл не является JSON.' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'В файле нет проекта.' };
  const record = raw as Record<string, unknown>;
  if (hasForbiddenKey(record)) return { ok: false, error: 'Файл содержит запрещённые поля.' };
  if (record.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, error: 'Эта версия схемы не поддерживается. Исходный файл не изменён.' };
  }
  const width = record.width;
  const height = record.height;
  if (!validEdge(width) || !validEdge(height)) return { ok: false, error: 'Некорректный размер холста.' };
  if (typeof record.cells !== 'string' || typeof record.name !== 'string' || typeof record.projectId !== 'string') {
    return { ok: false, error: 'В файле не хватает полей проекта.' };
  }
  const palette = parsePalette(record.palette);
  if (!palette) return { ok: false, error: 'Палитра повреждена.' };
  const cells = base64ToCells(record.cells, width, height);
  if (!cells) return { ok: false, error: 'Клетки повреждены или не совпадают с размером.' };
  for (const cell of cells) {
    if (cell !== 0 && (cell < 1 || cell > palette.length)) return { ok: false, error: 'Клетка ссылается на цвет вне палитры.' };
  }
  const symmetry = parseSymmetry(record.symmetry, width, height);
  if (!symmetry) return { ok: false, error: 'Настройки симметрии повреждены.' };
  return {
    ok: true,
    cells,
    file: {
      schemaVersion: SCHEMA_VERSION,
      projectId: record.projectId,
      name: record.name,
      width,
      height,
      palette,
      cells: record.cells,
      gridVisible: record.gridVisible !== false,
      checkerVisible: record.checkerVisible === true,
      checkerBlock: typeof record.checkerBlock === 'number' && record.checkerBlock >= 1 ? Math.round(record.checkerBlock) : 1,
      symmetry,
    },
  };
}

export function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return into;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  for (const [key, child] of Object.entries(value)) {
    into.add(key.toLowerCase());
    collectKeys(child, into);
  }
  return into;
}

export function hasForbiddenKey(value: unknown): boolean {
  const keys = collectKeys(value);
  return FORBIDDEN.some((key) => keys.has(key));
}

function validEdge(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_EDGE;
}

function parsePalette(value: unknown): PaletteColor[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) return null;
  const colors: PaletteColor[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const color = item as Record<string, unknown>;
    if (typeof color.id !== 'string' || typeof color.name !== 'string' || typeof color.hex !== 'string') return null;
    const hex = normalizeHex(color.hex);
    if (!hex) return null;
    colors.push({ id: color.id, name: color.name, hex });
  }
  return colors;
}

function parseSymmetry(value: unknown, width: number, height: number): SymmetrySettings | null {
  if (!value || typeof value !== 'object') return null;
  const symmetry = value as Record<string, unknown>;
  const mode = symmetry.mode;
  if (mode !== 'off' && mode !== 'vertical' && mode !== 'horizontal' && mode !== 'both') return null;
  if (typeof symmetry.axisX2 !== 'number' || typeof symmetry.axisY2 !== 'number') return null;
  return {
    mode: mode as SymmetryMode,
    axisX2: Math.max(0, Math.min(width * 2, symmetry.axisX2)),
    axisY2: Math.max(0, Math.min(height * 2, symmetry.axisY2)),
    showAxes: symmetry.showAxes !== false,
  };
}
