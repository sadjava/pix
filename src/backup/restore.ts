import type { PaletteColor, ProjectDocument, ProjectRecord, SymmetrySettings } from '../model/types.ts';
import { sha256Hex } from '../export/checksum.ts';
import { base64ToCells, cellsToBase64, cellsToBytes } from '../export/json.ts';
import { createDocument } from '../editor/canvas/grid.ts';
import type { CloudTrace, RugRow } from './protocol.ts';

export async function rugFromDocument(
  ownerId: string,
  record: ProjectRecord,
  doc: ProjectDocument,
  traces: CloudTrace[] = [],
): Promise<RugRow> {
  return {
    id: record.id,
    ownerId,
    name: record.name,
    width: doc.width,
    height: doc.height,
    schemaVersion: doc.schemaVersion,
    documentRevision: record.documentRevision,
    updatedAt: record.updatedAt,
    palette: doc.palette.map((color) => ({ id: color.id, name: color.name, hex: color.hex })),
    cells: cellsToBase64(doc.cells),
    gridVisible: doc.gridVisible,
    checkerVisible: doc.checkerVisible,
    checkerBlock: doc.checkerBlock,
    symmetry: { ...doc.symmetry },
    contentHash: await sha256Hex(cellsToBytes(doc.cells)),
    traces,
  };
}

/** Pictures travel in the existing symmetry column, so no new database column is required. */
export function packSymmetry(symmetry: SymmetrySettings, traces: CloudTrace[]): SymmetrySettings & { traces: CloudTrace[] } {
  return { ...symmetry, traces };
}

export function unpackSymmetry(value: unknown): { symmetry: SymmetrySettings; traces: CloudTrace[] } {
  const raw = value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {};
  const traces = parseCloudTraces(raw.traces);
  delete raw.traces;
  return { symmetry: raw as unknown as SymmetrySettings, traces };
}

export function parseCloudTraces(value: unknown): CloudTrace[] {
  if (!Array.isArray(value)) return [];
  const traces: CloudTrace[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.data !== 'string') continue;
    const width = numberOr(row.width, 0);
    const height = numberOr(row.height, 0);
    if (width <= 0 || height <= 0) continue;
    traces.push({
      id: row.id,
      x: numberOr(row.x, 0),
      y: numberOr(row.y, 0),
      width,
      height,
      rotation: numberOr(row.rotation, 0),
      opacity: numberOr(row.opacity, 1),
      cropX: numberOr(row.cropX, 0),
      cropY: numberOr(row.cropY, 0),
      cropW: numberOr(row.cropW, 1),
      cropH: numberOr(row.cropH, 1),
      mime: typeof row.mime === 'string' && row.mime ? row.mime : 'image/jpeg',
      data: row.data,
    });
  }
  return traces;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export async function documentFromRow(row: RugRow): Promise<ProjectDocument | null> {
  const cells = base64ToCells(row.cells, row.width, row.height);
  if (!cells) return null;
  const hash = await sha256Hex(cellsToBytes(cells));
  if (hash !== row.contentHash) return null;
  const palette = row.palette.filter((color): color is PaletteColor => Boolean(color?.id && color.hex && color.name));
  if (palette.length !== row.palette.length) return null;
  const doc = createDocument(row.width, row.height, palette);
  doc.cells = cells;
  doc.gridVisible = row.gridVisible;
  doc.checkerVisible = row.checkerVisible;
  doc.checkerBlock = row.checkerBlock;
  doc.symmetry = row.symmetry as SymmetrySettings;
  return doc;
}
