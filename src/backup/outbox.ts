import type { ProjectRecord } from '../model/types.ts';
import type { OutboxRow } from '../data/db.ts';
import type { ProjectRepository } from '../data/repository.ts';
import { emptyHistory } from '../editor/history/patches.ts';
import { applyBackupSuccess, decideSync, syncedRevision, type SyncTransport } from './protocol.ts';
import { backoffMs } from './scheduler.ts';
import { documentFromRow, rugFromDocument } from './restore.ts';

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
    let remote = null;
    try {
      remote = await transport.get(record.id);
    } catch {
      await fail(repo, queued, record);
      continue;
    }
    const decision = decideSync(record.documentRevision, syncedRevision(record.cloudRevisionId), remote?.documentRevision ?? null);
    if (decision === 'skip') {
      await repo.deleteOutbox(queued.id);
      if (record.syncState !== 'backed-up') {
        await repo.db.projects.put({ ...record, syncState: 'backed-up', cloudRevisionId: String(record.documentRevision), lastCloudBackupAt: record.lastCloudBackupAt ?? now });
      }
      continue;
    }
    if (decision === 'conflict' || (decision === 'pull' && !allowPull)) {
      await repo.db.projects.put({ ...record, syncState: 'conflict' });
      await repo.deleteOutbox(queued.id);
      continue;
    }
    if (decision === 'pull' && remote) {
      const doc = await documentFromRow(remote);
      if (!doc) {
        await fail(repo, queued, record);
        continue;
      }
      await repo.commit(record.id, {
        doc,
        history: emptyHistory(),
        patches: [],
        opNumber: remote.documentRevision,
        type: 'sync',
        recordPatch: {
          name: remote.name,
          syncState: 'backed-up',
          cloudRevisionId: String(remote.documentRevision),
          lastCloudBackupAt: remote.updatedAt,
        },
      });
      await repo.deleteOutbox(queued.id);
      continue;
    }
    const loaded = await repo.load(record.id);
    if (!('doc' in loaded)) {
      await fail(repo, queued, record);
      continue;
    }
    try {
      const row = await rugFromDocument(ownerId, loaded.record, loaded.doc);
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
  }
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
