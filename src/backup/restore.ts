import type { PaletteColor, ProjectDocument, ProjectRecord, SymmetrySettings } from '../model/types.ts';
import { sha256Hex } from '../export/checksum.ts';
import { base64ToCells, cellsToBase64, cellsToBytes } from '../export/json.ts';
import { createDocument } from '../editor/canvas/grid.ts';
import type { RugRow } from './protocol.ts';

export async function rugFromDocument(ownerId: string, record: ProjectRecord, doc: ProjectDocument): Promise<RugRow> {
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
  };
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
