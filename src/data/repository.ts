import type { CellPatch, HistoryEntry, JournalEntry, ProjectDocument, ProjectRecord } from '../model/types.ts';
import { SCHEMA_VERSION } from '../model/types.ts';
import { createDocument } from '../editor/canvas/grid.ts';
import { emptyHistory, parseHistory, type HistoryStacks } from '../editor/history/patches.ts';
import { cellsToBytes } from '../export/json.ts';
import { arrayBuffer } from '../export/checksum.ts';
import { migrateDocument, recoverCells } from './recover.ts';
import { createDb, type JournalRow, type RugDB, type SnapshotRow } from './db.ts';

export interface LoadedProject {
  record: ProjectRecord;
  doc: ProjectDocument;
  history: HistoryStacks;
}

export interface CommitInput {
  doc: ProjectDocument;
  history: HistoryStacks;
  patches: CellPatch[];
  opNumber: number;
  type: string;
  recordPatch?: Partial<ProjectRecord>;
}

export function isQuotaError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED';
  }
  return error instanceof Error && error.name === 'QuotaExceededError';
}

export class ProjectRepository {
  readonly db: RugDB;

  constructor(db: RugDB) {
    this.db = db;
  }

  static open(name = 'rug-pixel'): ProjectRepository {
    return new ProjectRepository(createDb(name));
  }

  close(): void {
    this.db.close();
  }

  async list(): Promise<ProjectRecord[]> {
    const rows = await this.db.projects.toArray();
    return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async create(input: { id?: string; name: string; width: number; height: number; now?: string }): Promise<LoadedProject> {
    const now = input.now ?? new Date().toISOString();
    const doc = createDocument(input.width, input.height);
    const record: ProjectRecord = {
      id: input.id ?? crypto.randomUUID(),
      name: input.name.trim() || 'Новый ковёр',
      width: doc.width,
      height: doc.height,
      schemaVersion: SCHEMA_VERSION,
      documentRevision: 1,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      lastLocalSavedAt: now,
      lastCloudBackupAt: null,
      syncState: 'local-only',
      localChecksum: null,
      cloudRevisionId: null,
    };
    const history = emptyHistory();
    await this.write(record, doc, history, [], 'create');
    return { record, doc, history };
  }

  async rename(id: string, name: string): Promise<void> {
    const record = await this.db.projects.get(id);
    if (!record) return;
    await this.db.projects.put({ ...record, name: name.trim() || record.name, updatedAt: new Date().toISOString() });
  }

  async duplicate(id: string): Promise<LoadedProject | null> {
    const loaded = await this.load(id);
    if (!('record' in loaded)) return null;
    const now = new Date().toISOString();
    const record: ProjectRecord = {
      ...loaded.record,
      id: crypto.randomUUID(),
      name: `${loaded.record.name} копия`,
      documentRevision: 1,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      lastLocalSavedAt: now,
      lastCloudBackupAt: null,
      syncState: 'local-only',
      localChecksum: null,
      cloudRevisionId: null,
    };
    const history = emptyHistory();
    await this.write(record, loaded.doc, history, [], 'duplicate');
    return { record, doc: loaded.doc, history };
  }

  async remove(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.projects, this.db.snapshots, this.db.journal, this.db.histories, this.db.outbox, async () => {
      await this.db.projects.delete(id);
      await this.db.snapshots.delete(id);
      await this.db.journal.where('projectId').equals(id).delete();
      await this.db.histories.delete(id);
      await this.db.outbox.where('projectId').equals(id).delete();
    });
  }

  async load(id: string): Promise<LoadedProject | { error: string }> {
    const record = await this.db.projects.get(id);
    const snapshot = await this.db.snapshots.get(id);
    if (!record || !snapshot) return { error: 'Проект не найден.' };
    const migrated = migrateDocument(snapshotToRaw(snapshot));
    if (!migrated.ok) return migrated;
    if (migrated.doc.cells.length !== snapshot.width * snapshot.height) {
      return { error: 'Запись повреждена. Исходные данные не изменены.' };
    }
    const journal = await this.db.journal.where('projectId').equals(id).toArray();
    const cells = recoverCells(migrated.doc.cells, snapshot.revision, journal);
    const historyRow = await this.db.histories.get(id);
    const history = parseHistory(historyRow ?? { undo: [], redo: [] });
    const doc = { ...migrated.doc, cells, viewport: snapshot.viewport ?? migrated.doc.viewport };
    return { record: { ...record, lastOpenedAt: record.lastOpenedAt }, doc, history };
  }

  async commit(id: string, input: CommitInput): Promise<ProjectRecord> {
    const existing = await this.db.projects.get(id);
    if (!existing) throw new Error('missing project');
    const now = new Date().toISOString();
    const record: ProjectRecord = {
      ...existing,
      ...input.recordPatch,
      width: input.doc.width,
      height: input.doc.height,
      schemaVersion: input.doc.schemaVersion,
      documentRevision: input.opNumber,
      updatedAt: now,
      lastLocalSavedAt: now,
    };
    await this.write(record, input.doc, input.history, journalFrom(input), input.type);
    return record;
  }

  async putOutbox(row: import('./db.ts').OutboxRow): Promise<void> {
    await this.db.outbox.put(row);
  }

  async listOutbox(projectId?: string): Promise<import('./db.ts').OutboxRow[]> {
    if (!projectId) return this.db.outbox.toArray();
    return this.db.outbox.where('projectId').equals(projectId).toArray();
  }

  async deleteOutbox(id: string): Promise<void> {
    await this.db.outbox.delete(id);
  }

  async readMeta<T>(key: string): Promise<T | null> {
    const row = await this.db.meta.get(key);
    return (row?.value as T) ?? null;
  }

  async writeMeta(key: string, value: unknown): Promise<void> {
    await this.db.meta.put({ key, value });
  }

  private async write(
    record: ProjectRecord,
    doc: ProjectDocument,
    history: HistoryStacks,
    journal: JournalEntry[],
    type: string,
  ): Promise<void> {
    const snapshot = toSnapshot(record.id, record.documentRevision, doc);
    await this.db.transaction('rw', this.db.projects, this.db.snapshots, this.db.journal, this.db.histories, async () => {
      await this.db.snapshots.put(snapshot);
      for (const entry of journal) {
        if (type === 'cancel' || type === 'undo' || type === 'redo') continue;
        await this.db.journal.add({ ...entry, projectId: record.id });
      }
      await this.db.histories.put({
        projectId: record.id,
        undo: history.undo,
        redo: history.redo,
        notice: history.notice,
      });
      await this.db.projects.put(record);
      const rows = await this.db.journal.where('projectId').equals(record.id).toArray();
      // ponytail: one transaction replaces the snapshot; the previous row stays if this transaction aborts.
      if (rows.length > 40) {
        await this.db.journal
          .where('projectId')
          .equals(record.id)
          .filter((row) => row.opNumber <= record.documentRevision)
          .delete();
      }
    });
  }
}

function journalFrom(input: CommitInput): JournalEntry[] {
  if (input.patches.length === 0) return [];
  if (input.type === 'cancel' || input.type === 'undo' || input.type === 'redo') return [];
  return [{ opNumber: input.opNumber, type: input.type, patches: input.patches, at: new Date().toISOString() }];
}

function toSnapshot(projectId: string, revision: number, doc: ProjectDocument): SnapshotRow {
  return {
    projectId,
    schemaVersion: doc.schemaVersion,
    revision,
    width: doc.width,
    height: doc.height,
    palette: doc.palette,
    cells: arrayBuffer(cellsToBytes(doc.cells)),
    gridVisible: doc.gridVisible,
    checkerVisible: doc.checkerVisible,
    checkerBlock: doc.checkerBlock,
    symmetry: doc.symmetry,
    viewport: doc.viewport,
  };
}

function snapshotToRaw(snapshot: SnapshotRow): unknown {
  const bytes = new Uint8Array(snapshot.cells);
  const cells = new Uint16Array(snapshot.width * snapshot.height);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength !== cells.length * 2) return { schemaVersion: snapshot.schemaVersion, width: snapshot.width, height: snapshot.height, cells: new ArrayBuffer(0), palette: snapshot.palette };
  for (let i = 0; i < cells.length; i++) cells[i] = view.getUint16(i * 2, true);
  return { ...snapshot, cells };
}

export type { HistoryEntry, JournalRow };
