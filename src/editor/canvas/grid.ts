import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  EMPTY_CELL,
  MAX_EDGE,
  SCHEMA_VERSION,
  WARN_EDGE,
  type PaletteColor,
  type ProjectDocument,
  type SymmetrySettings,
  type Viewport,
} from '../../model/types.ts';
import { defaultPalette } from '../palette/palette.ts';

export interface Grid {
  width: number;
  height: number;
  cells: Uint16Array;
}

export function indexOf(width: number, x: number, y: number): number {
  return y * width + x;
}

export function inBounds(width: number, height: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

export function createCells(width: number, height: number, fill = EMPTY_CELL): Uint16Array {
  if (!validEdge(width) || !validEdge(height)) throw new Error('invalid size');
  const cells = new Uint16Array(width * height);
  if (fill !== 0) cells.fill(fill);
  return cells;
}

function validEdge(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_EDGE;
}

export type SizeDecision = 'ok' | 'confirm' | 'reject';

export function sizeDecision(width: number, height: number, deviceMemory?: number): SizeDecision {
  if (!validEdge(width) || !validEdge(height)) return 'reject';
  if (width > WARN_EDGE || height > WARN_EDGE) {
    if (deviceMemory !== undefined && deviceMemory > 0 && deviceMemory < 2) return 'reject';
    return 'confirm';
  }
  return 'ok';
}

export function defaultSymmetry(width: number, height: number): SymmetrySettings {
  return { mode: 'off', axisX2: width, axisY2: height, showAxes: true };
}

export function defaultViewport(): Viewport {
  return { scale: 1, panX: 16, panY: 16, cellSize: 16 };
}

export function createDocument(
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  palette: PaletteColor[] = defaultPalette(),
): ProjectDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    width,
    height,
    palette,
    cells: createCells(width, height),
    gridVisible: true,
    checkerVisible: false,
    checkerBlock: 1,
    symmetry: defaultSymmetry(width, height),
    viewport: defaultViewport(),
  };
}

export function getCell(doc: Pick<ProjectDocument, 'width' | 'height' | 'cells'>, x: number, y: number): number {
  if (!inBounds(doc.width, doc.height, x, y)) return EMPTY_CELL;
  return doc.cells[indexOf(doc.width, x, y)] ?? EMPTY_CELL;
}

/** Copy the intersection. `cropped` is true when a non-empty cell would fall outside the new size. */
export function resizeDocument(doc: ProjectDocument, width: number, height: number): {
  doc: ProjectDocument;
  cropped: boolean;
} | null {
  if (sizeDecision(width, height) === 'reject') return null;
  const cells = createCells(width, height);
  const copyW = Math.min(doc.width, width);
  const copyH = Math.min(doc.height, height);
  for (let y = 0; y < copyH; y++) {
    for (let x = 0; x < copyW; x++) {
      cells[indexOf(width, x, y)] = doc.cells[indexOf(doc.width, x, y)] ?? 0;
    }
  }
  let cropped = false;
  if (width < doc.width || height < doc.height) {
    for (let y = 0; y < doc.height && !cropped; y++) {
      for (let x = 0; x < doc.width; x++) {
        if ((x >= width || y >= height) && doc.cells[indexOf(doc.width, x, y)] !== EMPTY_CELL) {
          cropped = true;
          break;
        }
      }
    }
  }
  return {
    cropped,
    doc: {
      ...doc,
      width,
      height,
      cells,
      symmetry: {
        ...doc.symmetry,
        axisX2: clampAxis(doc.symmetry.axisX2, width),
        axisY2: clampAxis(doc.symmetry.axisY2, height),
      },
    },
  };
}

function clampAxis(axis2: number, edge: number): number {
  if (axis2 < 0) return 0;
  if (axis2 > edge * 2) return edge * 2;
  return axis2;
}

export function cloneCells(cells: Uint16Array): Uint16Array {
  return new Uint16Array(cells);
}
