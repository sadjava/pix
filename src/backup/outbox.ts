import type { ProjectRecord } from '../model/types.ts';
import type { OutboxRow, TraceRow } from '../data/db.ts';
import type { ProjectRepository } from '../data/repository.ts';
import { emptyHistory } from '../editor/history/patches.ts';
import { applyBackupSuccess, decideSync, syncedRevision, type CloudTrace, type SyncTransport } from './protocol.ts';
import { backoffMs } from './scheduler.ts';
import { base64ToBytes, bytesToBase64, documentFromRow, rugFromDocument } from './restore.ts';

export async function enqueueBackup(repo: ProjectRepository, record: ProjectRecord): Promise<OutboxRow> {
  const pending = (await repo.listOutbox(record.id))[0];
  const row: OutboxRow = pending
    ? { ...pending, localRevision: record.documentRevision, status: 'pending', nextAttemptAt: Date.now() }
    : {
        id: crypto.randomUUID(),
        projectId: record.id,
        localRevision: record.documentRevision,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: Date.now(),
      };
  await repo.putOutbox(row);
  return row;
}

/** One project at a time. The queue stores an id, and the row is read from IndexedDB at send time. */
export async function drainOutbox(
  repo: ProjectRepository,
  transport: SyncTransport,
  ownerId: string,
  now: string,
  allowPull = false,
): Promise<void> {
  const rows = (await repo.listOutbox()).sort((a, b) => a.localRevision - b.localRevision);
  const seen = new Set<string>();
  for (const queued of rows) {
    if (seen.has(queued.projectId)) continue;
    seen.add(queued.projectId);
    if (queued.nextAttemptAt > Date.now()) continue;
    const record = await repo.db.projects.get(queued.projectId);
    if (!record) {
      await repo.deleteOutbox(queued.id);
      continue;
    }
    let remote: { documentRevision: number; updatedAt: string } | null = null;
    try {
      remote = await transport.head(record.id);
    } catch {
      await fail(repo, queued, record);
      continue;
    }
    let decision = decideSync(record.documentRevision, syncedRevision(record.cloudRevisionId), remote?.documentRevision ?? null);
    if (decision === 'skip' && remote && record.updatedAt > remote.updatedAt) decision = 'push';
    if (decision === 'skip') {
      await repo.deleteOutbox(queued.id);
      if (record.syncState !== 'backed-up') {
        await repo.db.projects.put({ ...record, syncState: 'backed-up', cloudRevisionId: String(record.documentRevision), lastCloudBackupAt: record.lastCloudBackupAt ?? now });
      }
      continue;
    }
    if (decision === 'conflict' || (decision === 'pull' && !allowPull)) {
      if (decision === 'conflict') await keepRemotePictures(repo, transport, record.id);
      await repo.db.projects.put({ ...record, syncState: 'conflict' });
      await repo.deleteOutbox(queued.id);
      continue;
    }
    if (decision === 'pull') {
      const row = await transport.get(record.id);
      const doc = row ? await documentFromRow(row) : null;
      if (!row || !doc) {
        await fail(repo, queued, record);
        continue;
      }
      await repo.commit(record.id, {
        doc,
        history: emptyHistory(),
        patches: [],
        opNumber: row.documentRevision,
        type: 'sync',
        recordPatch: {
          name: row.name,
          syncState: 'backed-up',
          cloudRevisionId: String(row.documentRevision),
          lastCloudBackupAt: row.updatedAt,
        },
      });
      await repo.replaceTraces(record.id, traceRows(record.id, row.traces));
      await repo.deleteOutbox(queued.id);
      continue;
    }
    const loaded = await repo.load(record.id);
    if (!('doc' in loaded)) {
      await fail(repo, queued, record);
      continue;
    }
    try {
      const row = await rugFromDocument(ownerId, loaded.record, loaded.doc, await cloudTraces(await repo.listTraces(loaded.record.id)));
      await transport.upsert(row);
      await repo.deleteOutbox(queued.id);
      const fresh = await repo.db.projects.get(record.id);
      if (!fresh) continue;
      const patched = applyBackupSuccess(
        {
          documentRevision: fresh.documentRevision,
          syncState: fresh.syncState,
          lastCloudBackupAt: fresh.lastCloudBackupAt,
          cloudRevisionId: fresh.cloudRevisionId,
        },
        queued.localRevision,
        String(queued.localRevision),
        now,
        false,
      );
      await repo.db.projects.put({ ...fresh, ...patched, localChecksum: row.contentHash });
    } catch {
      await fail(repo, queued, record);
    }
  }
}

const DELETED = 'deletedRugIds';

export async function rememberDeleted(repo: ProjectRepository, id: string): Promise<void> {
  const ids = new Set(await repo.readMeta<string[]>(DELETED) ?? []);
  ids.add(id);
  await repo.writeMeta(DELETED, [...ids]);
}

export async function forgetDeleted(repo: ProjectRepository, id: string): Promise<void> {
  const ids = (await repo.readMeta<string[]>(DELETED) ?? []).filter((item) => item !== id);
  await repo.writeMeta(DELETED, ids);
}

async function flushDeleted(repo: ProjectRepository, transport: SyncTransport): Promise<Set<string>> {
  const ids = await repo.readMeta<string[]>(DELETED) ?? [];
  const left: string[] = [];
  for (const id of ids) {
    try {
      await transport.remove(id);
    } catch {
      left.push(id);
    }
  }
  await repo.writeMeta(DELETED, left);
  return new Set(left);
}

export async function syncAccount(
  repo: ProjectRepository,
  transport: SyncTransport,
  ownerId: string,
  now: string,
): Promise<void> {
  const deleted = await flushDeleted(repo, transport);
  for (const project of await repo.list()) await enqueueBackup(repo, project);
  await drainOutbox(repo, transport, ownerId, now, true);
  const remote = await transport.listRefs();
  const local = new Set((await repo.list()).map((item) => item.id));
  for (const ref of remote) {
    if (local.has(ref.id) || deleted.has(ref.id)) continue;
    const row = await transport.get(ref.id);
    if (!row) continue;
    const doc = await documentFromRow(row);
    if (!doc) continue;
    await repo.create({ id: row.id, name: row.name, width: row.width, height: row.height, now: row.updatedAt });
    await repo.commit(row.id, {
      doc,
      history: emptyHistory(),
      patches: [],
      opNumber: row.documentRevision,
      type: 'sync',
      recordPatch: {
        name: row.name,
        syncState: 'backed-up',
        cloudRevisionId: String(row.documentRevision),
        lastCloudBackupAt: row.updatedAt,
      },
    });
    await repo.replaceTraces(row.id, traceRows(row.id, row.traces));
  }
}

async function keepRemotePictures(repo: ProjectRepository, transport: SyncTransport, projectId: string): Promise<void> {
  const local = await repo.listTraces(projectId);
  if (local.length > 0) return;
  try {
    const remote = await transport.get(projectId);
    if (remote && remote.traces.length > 0) await repo.replaceTraces(projectId, traceRows(projectId, remote.traces));
  } catch {
    // The stitches stay in conflict. The pictures can arrive on the next sync.
  }
}

async function cloudTraces(rows: TraceRow[]): Promise<CloudTrace[]> {
  const traces: CloudTrace[] = [];
  for (const row of rows) {
    const bytes = new Uint8Array(await row.blob.arrayBuffer());
    traces.push({
      id: row.id,
      x: row.x,
      y: row.y,
      width: row.width,
      height: row.height,
      rotation: row.rotation,
      opacity: row.opacity,
      cropX: row.cropX,
      cropY: row.cropY,
      cropW: row.cropW,
      cropH: row.cropH,
      mime: row.blob.type || 'image/jpeg',
      data: bytesToBase64(bytes),
    });
  }
  return traces;
}

function traceRows(projectId: string, traces: CloudTrace[]): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const trace of traces) {
    const bytes = base64ToBytes(trace.data);
    if (!bytes) continue;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    rows.push({
      id: trace.id,
      projectId,
      blob: new Blob([copy], { type: trace.mime }),
      x: trace.x,
      y: trace.y,
      width: trace.width,
      height: trace.height,
      rotation: trace.rotation,
      opacity: trace.opacity,
      cropX: trace.cropX,
      cropY: trace.cropY,
      cropW: trace.cropW,
      cropH: trace.cropH,
    });
  }
  return rows;
}

async function fail(repo: ProjectRepository, queued: OutboxRow, record: ProjectRecord): Promise<void> {
  await repo.putOutbox({
    ...queued,
    status: 'failed',
    attempts: queued.attempts + 1,
    nextAttemptAt: Date.now() + backoffMs(queued.attempts, 0),
  });
  if (record.documentRevision === queued.localRevision) {
    await repo.db.projects.put({ ...record, syncState: 'error' });
  }
}
