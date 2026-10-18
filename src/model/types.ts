export const SCHEMA_VERSION = 1;
export const EMPTY_CELL = 0;
export const DEFAULT_WIDTH = 100;
export const DEFAULT_HEIGHT = 100;
export const WARN_EDGE = 500;
export const MAX_EDGE = 4000;
export const HISTORY_LIMIT = 40;
export const CHECKPOINT_MS = 500;
export const BACKUP_DEBOUNCE_MS = 15_000;

export interface PaletteColor {
  id: string;
  name: string;
  hex: string;
  /** Dropped from the swatch list. Stitches that already use it stay. */
  hidden?: boolean;
}

export type SymmetryMode = 'off' | 'vertical' | 'horizontal' | 'both';

export interface SymmetrySettings {
  mode: SymmetryMode;
  axisX2: number;
  axisY2: number;
  showAxes: boolean;
}

export interface Viewport {
  scale: number;
  panX: number;
  panY: number;
  cellSize: number;
}

export type SyncState =
  | 'local-only'
  | 'pending'
  | 'uploading'
  | 'backed-up'
  | 'error'
  | 'conflict';

export interface ProjectRecord {
  id: string;
  name: string;
  width: number;
  height: number;
  schemaVersion: number;
  documentRevision: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  lastLocalSavedAt: string | null;
  lastCloudBackupAt: string | null;
  syncState: SyncState;
  localChecksum: string | null;
  cloudRevisionId: string | null;
  deletedAt?: string | null;
}

export interface ProjectDocument {
  schemaVersion: number;
  width: number;
  height: number;
  palette: PaletteColor[];
  cells: Uint16Array;
  gridVisible: boolean;
  checkerVisible: boolean;
  checkerBlock: number;
  symmetry: SymmetrySettings;
  viewport: Viewport;
}

export interface CellPatch {
  index: number;
  before: number;
  after: number;
}

export interface PackedPatches {
  index: Uint32Array;
  before: Uint16Array;
  after: Uint16Array;
}

export interface HistoryEntry {
  opNumber: number;
  type: string;
  patches: CellPatch[];
  /** Large edits, such as a fill, stay undoable without one object per cell. */
  packed?: PackedPatches;
  /** Set when the edit also changes which colors exist. Undo restores both. */
  paletteBefore?: PaletteColor[];
  paletteAfter?: PaletteColor[];
  slotBefore?: number;
  slotAfter?: number;
}

export interface JournalEntry {
  opNumber: number;
  type: string;
  patches: CellPatch[];
  at: string;
}

export type LocalStatus = 'dirty' | 'saving-local' | 'saved-local' | 'local-save-error';

export type BackupUiState =
  | 'disabled'
  | 'pending'
  | 'uploading'
  | 'backed-up'
  | 'error'
  | 'conflict';

export interface Point {
  x: number;
  y: number;
}

export type ToolId =
  | 'pencil'
  | 'eraser'
  | 'fill'
  | 'picker'
  | 'line'
  | 'circle'
  | 'rect'
  | 'diamond'
  | 'select'
  | 'pan'
  | 'trace';

export interface ClipboardPayload {
  schemaVersion: number;
  width: number;
  height: number;
  cells: Uint16Array;
  palette: PaletteColor[];
}
