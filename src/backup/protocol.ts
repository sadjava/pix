import type { PaletteColor, SymmetrySettings } from '../model/types.ts';

/** One current row per rug. The database stores columns, not a JSON file. */
export interface RugRow {
  id: string;
  ownerId: string;
  name: string;
  width: number;
  height: number;
  schemaVersion: number;
  documentRevision: number;
  updatedAt: string;
  palette: PaletteColor[];
  cells: string;
  gridVisible: boolean;
  checkerVisible: boolean;
  checkerBlock: number;
  symmetry: SymmetrySettings;
  contentHash: string;
}

/** Enough to notice a remote rug without downloading its cells. */
export interface RugRef {
  id: string;
  name: string;
  width: number;
  height: number;
  documentRevision: number;
  updatedAt: string;
}

export interface SyncTransport {
  upsert(row: RugRow): Promise<void>;
  get(projectId: string): Promise<RugRow | null>;
  /** Revision and time only, so a sync does not download the cell blob. */
  head(projectId: string): Promise<{ documentRevision: number; updatedAt: string } | null>;
  list(): Promise<RugRow[]>;
  listRefs(): Promise<RugRef[]>;
  remove(projectId: string): Promise<void>;
}

export type SyncDecision = 'push' | 'pull' | 'conflict' | 'skip';

/** A newer local revision is uploaded. An older cloud row never replaces it. */
export function decideSync(localRevision: number, syncedRevision: number, remoteRevision: number | null): SyncDecision {
  if (remoteRevision === null || localRevision > remoteRevision) return 'push';
  if (remoteRevision === localRevision) return 'skip';
  if (localRevision === syncedRevision) return 'pull';
  return 'conflict';
}

export function syncedRevision(cloudRevisionId: string | null): number {
  if (!cloudRevisionId) return 0;
  const value = Number(cloudRevisionId);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export interface BackupRecordPatch {
  documentRevision: number;
  syncState: 'local-only' | 'pending' | 'uploading' | 'backed-up' | 'error' | 'conflict';
  lastCloudBackupAt: string | null;
  cloudRevisionId: string | null;
}

/** An older finished upload must not mark a newer local revision as backed up. */
export function applyBackupSuccess(
  record: BackupRecordPatch,
  completedRevision: number,
  versionId: string,
  at: string,
  conflict: boolean,
): BackupRecordPatch {
  if (completedRevision < record.documentRevision) {
    return record.syncState === 'backed-up' || record.syncState === 'conflict'
      ? record
      : { ...record, syncState: 'pending' };
  }
  if (conflict) {
    return { ...record, syncState: 'conflict', lastCloudBackupAt: at, cloudRevisionId: versionId };
  }
  return { ...record, syncState: 'backed-up', lastCloudBackupAt: at, cloudRevisionId: versionId };
}
