import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import sql from '../../supabase/migrations/001_backups.sql?raw';
import { ProjectRepository } from '../data/repository.ts';
import { emptyHistory } from '../editor/history/patches.ts';
import { canReadBackup, canWriteBackup } from './rls.ts';
import { MemoryTransport } from './memoryTransport.ts';
import { drainOutbox, enqueueBackup, rememberDeleted, syncAccount } from './outbox.ts';
import { applyBackupSuccess, decideSync } from './protocol.ts';
import { documentFromRow, rugFromDocument } from './restore.ts';
import { BackupScheduler, backoffMs } from './scheduler.ts';

beforeEach(() => {
  indexedDB = new IDBFactory();
});

describe('database sync', () => {
  it('keeps one row and retries the same id after a failed write', async () => {
    const repo = ProjectRepository.open('sync');
    const created = await repo.create({ name: 'Облако', width: 2, height: 2 });
    const transport = new MemoryTransport();
    transport.failUpsert = true;
    await enqueueBackup(repo, created.record);
    await drainOutbox(repo, transport, 'owner-1', '2026-10-16T00:00:00.000Z');
    expect(transport.rows.size).toBe(0);
    expect(await repo.listOutbox()).toHaveLength(1);
    transport.failUpsert = false;
    const pending = (await repo.listOutbox())[0];
    if (!pending) throw new Error('outbox');
    await repo.putOutbox({ ...pending, nextAttemptAt: 0 });
    await drainOutbox(repo, transport, 'owner-1', '2026-10-16T00:01:00.000Z');
    expect(transport.rows.size).toBe(1);
    expect(transport.rows.get(created.record.id)?.documentRevision).toBe(1);
    repo.close();
  });

  it('keeps the pending outbox when the network drops and does not clobber a newer revision', async () => {
    const repo = ProjectRepository.open('backup');
    const created = await repo.create({ name: 'Облако', width: 2, height: 2 });
    const row = await enqueueBackup(repo, created.record);
    const transport = new MemoryTransport();
    transport.failUpsert = true;
    await drainOutbox(repo, transport, 'owner-1', '2026-10-16T00:00:00.000Z');
    expect(await repo.listOutbox()).toHaveLength(1);
    const record = await repo.db.projects.get(created.record.id);
    expect(record?.syncState).toBe('error');
    const pending = (await repo.listOutbox())[0];
    if (!pending) throw new Error('outbox');
    await repo.putOutbox({ ...pending, nextAttemptAt: 0 });
    transport.failUpsert = false;
    await repo.db.projects.put({ ...created.record, documentRevision: row.localRevision + 3, syncState: 'pending' });
    await drainOutbox(repo, transport, 'owner-1', '2026-10-16T00:01:00.000Z');
    const after = await repo.db.projects.get(created.record.id);
    expect(after?.syncState).toBe('pending');
    expect(after?.documentRevision).toBe(row.localRevision + 3);
    expect(transport.rows.size).toBe(1);
    repo.close();
  });

  it('restores a row into cells and rejects a bad hash', async () => {
    const transport = new MemoryTransport();
    const repo = ProjectRepository.open('restore');
    const created = await repo.create({ name: 'Снимок', width: 2, height: 2 });
    created.doc.cells[0] = 1;
    const saved = await repo.commit(created.record.id, {
      doc: created.doc,
      history: emptyHistory(),
      patches: [],
      opNumber: 4,
      type: 'stroke',
    });
    await enqueueBackup(repo, saved);
    await drainOutbox(repo, transport, 'owner-1', '2026-10-16T00:00:00.000Z');
    const row = transport.rows.get(created.record.id);
    if (!row) throw new Error('row');
    const doc = await documentFromRow(row);
    expect(doc?.cells[0]).toBe(1);
    expect(await documentFromRow({ ...row, contentHash: '0'.repeat(64) })).toBeNull();
    expect(await repo.list()).toHaveLength(1);
    repo.close();
  });

  it('marks diverged revisions as a conflict and hides another user', async () => {
    expect(decideSync(5, 1, 3)).toBe('push');
    expect(decideSync(2, 1, 1)).toBe('push');
    expect(decideSync(1, 1, 3)).toBe('pull');
    expect(decideSync(2, 1, 4)).toBe('conflict');
    const repo = ProjectRepository.open('conflict');
    const created = await repo.create({ name: 'Спор', width: 2, height: 2 });
    const transport = new MemoryTransport();
    const remote = await rugFromDocument('owner-1', { ...created.record, documentRevision: 3, cloudRevisionId: null }, created.doc);
    await transport.upsert(remote);
    await repo.db.projects.put({ ...created.record, documentRevision: 2, cloudRevisionId: '1', syncState: 'pending' });
    await enqueueBackup(repo, { ...created.record, documentRevision: 2 });
    await drainOutbox(repo, transport, 'owner-1', '2026-10-16T00:00:00.000Z', true);
    const after = await repo.db.projects.get(created.record.id);
    expect(after?.syncState).toBe('conflict');
    expect(after?.documentRevision).toBe(2);
    expect(transport.rows.get(created.record.id)?.documentRevision).toBe(3);
    transport.actorId = 'other';
    expect(await transport.get(created.record.id)).toBeNull();
    await expect(transport.upsert(remote)).rejects.toThrow('forbidden');
    const older = applyBackupSuccess(
      { documentRevision: 5, syncState: 'pending', lastCloudBackupAt: null, cloudRevisionId: null },
      3,
      '3',
      't',
      false,
    );
    expect(older.syncState).toBe('pending');
    repo.close();
  });

  it('uploads a newer local copy over an older cloud row and keeps the local stitches', async () => {
    const repo = ProjectRepository.open('newer');
    const created = await repo.create({ name: 'Новее', width: 2, height: 2 });
    created.doc.cells[0] = 1;
    const saved = await repo.commit(created.record.id, {
      doc: created.doc,
      history: emptyHistory(),
      patches: [{ index: 0, before: 0, after: 1 }],
      opNumber: created.record.documentRevision,
      type: 'stroke',
    });
    const transport = new MemoryTransport();
    const staleDoc = { ...created.doc, cells: new Uint16Array(created.doc.cells.length) };
    const stale = await rugFromDocument('owner-1', { ...saved, updatedAt: '2026-10-17T21:36:20.000Z' }, staleDoc);
    await transport.upsert(stale);
    await enqueueBackup(repo, saved);
    await drainOutbox(repo, transport, 'owner-1', '2026-10-18T07:17:39.000Z');
    const remote = transport.rows.get(saved.id);
    const restored = remote ? await documentFromRow(remote) : null;
    expect(restored?.cells[0]).toBe(1);
    const local = await repo.load(saved.id);
    expect('doc' in local && local.doc.cells[0]).toBe(1);
    expect(local && 'record' in local && local.record.syncState).toBe('backed-up');
    repo.close();
  });

  it('deletes the cloud row and does not pull the rug back', async () => {
    const repo = ProjectRepository.open('gone');
    const created = await repo.create({ name: 'Уходит', width: 2, height: 2 });
    const transport = new MemoryTransport();
    await enqueueBackup(repo, created.record);
    await drainOutbox(repo, transport, 'owner-1', '2026-10-16T00:00:00.000Z');
    expect(transport.rows.size).toBe(1);
    await repo.remove(created.record.id);
    await rememberDeleted(repo, created.record.id);
    await syncAccount(repo, transport, 'owner-1', '2026-10-16T00:02:00.000Z');
    expect(transport.rows.size).toBe(0);
    expect(await repo.list()).toHaveLength(0);
    repo.close();
  });

  it('waits out the debounce unless flushed', () => {
    let now = 0;
    const scheduler = new BackupScheduler(() => now, 15_000);
    scheduler.noteChange();
    expect(scheduler.shouldRun({ enabled: true, online: true, signedIn: true })).toBe(false);
    scheduler.flush();
    expect(scheduler.shouldRun({ enabled: true, online: true, signedIn: true })).toBe(true);
    expect(scheduler.shouldRun({ enabled: false, online: true, signedIn: true })).toBe(false);
    expect(backoffMs(2, 0)).toBe(4000);
  });
});

describe('row level security', () => {
  it('allows only the owning authenticated user', () => {
    const sqlText = sql.toLowerCase();
    expect(sqlText).toContain('enable row level security');
    expect(sqlText).toContain('owner_id = auth.uid()');
    expect(sqlText).toContain('public.rugs');
    expect(sqlText).not.toContain('to anon');
    expect(sqlText).not.toMatch(/to service_role/);
    const owner = { role: 'authenticated' as const, userId: 'user-a' };
    expect(canReadBackup(owner, 'user-a')).toBe(true);
    expect(canWriteBackup(owner, 'user-b')).toBe(false);
    expect(canReadBackup({ role: 'anon', userId: null }, 'user-a')).toBe(false);
    expect(canReadBackup({ role: 'authenticated', userId: 'user-b' }, 'user-a')).toBe(false);
  });
});
