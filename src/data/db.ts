import Dexie, { type Table } from 'dexie';
import type { HistoryEntry, JournalEntry, PaletteColor, ProjectRecord, SymmetrySettings, Viewport } from '../model/types.ts';

export interface SnapshotRow {
  projectId: string;
  schemaVersion: number;
  revision: number;
  width: number;
  height: number;
  palette: PaletteColor[];
  cells: ArrayBuffer;
  gridVisible: boolean;
  checkerVisible: boolean;
  checkerBlock: number;
  symmetry: SymmetrySettings;
  viewport: Viewport;
}

export interface JournalRow extends JournalEntry {
  localId?: number;
  projectId: string;
}

export interface HistoryRow {
  projectId: string;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  notice: string | null;
}

export interface OutboxRow {
  id: string;
  projectId: string;
  localRevision: number;
  status: 'pending' | 'uploading' | 'failed';
  attempts: number;
  nextAttemptAt: number;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export class RugDB extends Dexie {
  projects!: Table<ProjectRecord, string>;
  snapshots!: Table<SnapshotRow, string>;
  journal!: Table<JournalRow, number>;
  histories!: Table<HistoryRow, string>;
  meta!: Table<MetaRow, string>;
  outbox!: Table<OutboxRow, string>;

  constructor(name = 'rug-pixel') {
    super(name);
    this.version(1).stores({
      projects: 'id, updatedAt',
      snapshots: 'projectId',
      journal: '++localId, projectId, [projectId+opNumber]',
      histories: 'projectId',
      meta: 'key',
      outbox: 'id, projectId',
    });
  }
}

export function createDb(name = 'rug-pixel'): RugDB {
  return new RugDB(name);
}
