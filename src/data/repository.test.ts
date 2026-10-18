import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../editor/canvas/grid.ts';
import { emptyHistory } from '../editor/history/patches.ts';
import { EditorSession } from '../editor/session.ts';
import { migrateDocument, recoverCells } from './recover.ts';
import { ProjectRepository } from './repository.ts';
import { SaveQueue } from './autosave/queue.ts';

beforeEach(() => {
  indexedDB = new IDBFactory();
});

async function paintAndSave(repo: ProjectRepository, id: string, x: number): Promise<void> {
  const loaded = await repo.load(id);
  if (!('doc' in loaded)) throw new Error('load');
  const editor = new EditorSession(loaded.doc, loaded.history, loaded.record.documentRevision);
  editor.colorSlot = 1;
  let pending: Promise<unknown> = Promise.resolve();
  editor.onPersist = (payload) => {
    pending = repo.commit(id, payload);
  };
  editor.pointerDown({ x, y: 0 });
  editor.pointerUp();
  await pending;
}

describe('local projects', () => {
  it('restores three projects after reopen without calling the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const repo = ProjectRepository.open('rugs');
    const ids = [];
    for (const name of ['А', 'Б', 'В']) {
      const created = await repo.create({ name, width: 6, height: 4 });
      ids.push(created.record.id);
      await paintAndSave(repo, created.record.id, name === 'А' ? 1 : 2);
    }
    repo.close();
    const again = ProjectRepository.open('rugs');
    const list = await again.list();
    expect(list.map((item) => item.name).sort()).toEqual(['А', 'Б', 'В']);
    for (const id of ids) {
      const loaded = await again.load(id);
      expect('error' in loaded).toBe(false);
      if ('doc' in loaded) expect([...loaded.doc.cells].some((cell) => cell === 1)).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    again.close();
  });

  it('replays a journal that landed ahead of the snapshot', async () => {
    const repo = ProjectRepository.open('journal');
    const created = await repo.create({ name: 'Ж', width: 4, height: 1 });
    await repo.db.journal.add({
      projectId: created.record.id,
      opNumber: created.record.documentRevision + 1,
      type: 'checkpoint',
      at: 't',
      patches: [{ index: 2, before: 0, after: 1 }],
    });
    const loaded = await repo.load(created.record.id);
    expect('doc' in loaded && loaded.doc.cells[2]).toBe(1);
    repo.close();
  });

  it('keeps a broken snapshot untouched', async () => {
    const repo = ProjectRepository.open('broken');
    const created = await repo.create({ name: 'Битый', width: 2, height: 2 });
    await repo.db.snapshots.put({
      projectId: created.record.id,
      schemaVersion: 99,
      revision: 1,
      width: 2,
      height: 2,
      palette: created.doc.palette,
      cells: new Uint8Array([1, 2, 3]).buffer,
      gridVisible: true,
      checkerVisible: false,
      checkerBlock: 1,
      symmetry: created.doc.symmetry,
      viewport: created.doc.viewport,
    });
    const loaded = await repo.load(created.record.id);
    expect(loaded).toEqual({ ok: false, error: expect.stringContaining('Неизвестная версия') });
    const raw = await repo.db.snapshots.get(created.record.id);
    expect(raw?.schemaVersion).toBe(99);
    expect(await repo.list()).toHaveLength(1);
    repo.close();
  });

  it('migrates schema 0 and recovers cells from patches', () => {
    const migrated = migrateDocument({
      schemaVersion: 0,
      width: 2,
      height: 1,
      palette: [{ id: 'a', name: 'A', hex: '#112233' }],
      cells: [0, 4],
    });
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      const cells = recoverCells(migrated.doc.cells, 1, [
        { opNumber: 2, type: 'stroke', at: 't', patches: [{ index: 0, before: 0, after: 3 }] },
      ]);
      expect(cells[0]).toBe(3);
      expect(cells[1]).toBe(4);
    }
    const unknown = migrateDocument({ schemaVersion: 7, width: 1, height: 1, cells: [0], palette: [] });
    expect(unknown.ok).toBe(false);
  });

  it('switches projects only after the previous edit is stored', async () => {
    const repo = ProjectRepository.open('switch');
    const first = await repo.create({ name: '1', width: 4, height: 2 });
    const second = await repo.create({ name: '2', width: 4, height: 2 });
    await paintAndSave(repo, first.record.id, 0);
    const other = await repo.load(second.record.id);
    const back = await repo.load(first.record.id);
    expect('doc' in other && other.doc.cells[0]).toBe(0);
    expect('doc' in back && back.doc.cells[0]).toBe(1);
    repo.close();
  });

  it('pans without a new rug time and drops journal rows the snapshot already has', async () => {
    const repo = ProjectRepository.open('pan');
    const created = await repo.create({ name: 'Сдвиг', width: 4, height: 2 });
    await paintAndSave(repo, created.record.id, 1);
    const stamped = await repo.db.projects.get(created.record.id);
    if (!stamped) throw new Error('record');
    const loaded = await repo.load(created.record.id);
    if (!('doc' in loaded)) throw new Error('load');
    loaded.doc.viewport = { ...loaded.doc.viewport, panX: 40 };
    const after = await repo.commit(created.record.id, {
      doc: loaded.doc,
      history: loaded.history,
      patches: [],
      opNumber: loaded.record.documentRevision,
      type: 'viewport',
    });
    expect(after.updatedAt).toBe(stamped.updatedAt);
    expect(after.documentRevision).toBe(stamped.documentRevision);
    const again = await repo.load(created.record.id);
    expect('doc' in again && again.doc.viewport.panX).toBe(40);
    expect('doc' in again && again.doc.cells[1]).toBe(1);
    expect(await repo.db.journal.where('projectId').equals(created.record.id).count()).toBe(0);
    repo.close();
  });

  it('hides a deleted rug and brings it back', async () => {
    const repo = ProjectRepository.open('trash');
    const created = await repo.create({ name: 'Корзина', width: 2, height: 2 });
    await repo.markDeleted(created.record.id, '2026-10-18T07:00:00.000Z');
    expect(await repo.list()).toHaveLength(0);
    expect(await repo.listDeleted()).toHaveLength(1);
    const kept = await repo.load(created.record.id);
    expect('doc' in kept).toBe(true);
    await repo.markDeleted(created.record.id, null);
    expect((await repo.list()).map((item) => item.name)).toEqual(['Корзина']);
    repo.close();
  });

  it('duplicates and renames without touching another project', async () => {
    const repo = ProjectRepository.open('dup');
    const created = await repo.create({ name: 'Оригинал', width: 3, height: 3 });
    await paintAndSave(repo, created.record.id, 1);
    await repo.rename(created.record.id, 'Новое');
    const copy = await repo.duplicate(created.record.id);
    expect(copy?.record.id).not.toBe(created.record.id);
    expect(copy?.record.syncState).toBe('local-only');
    expect(copy?.record.cloudRevisionId).toBeNull();
    const named = await repo.load(created.record.id);
    expect('record' in named && named.record.name).toBe('Новое');
    repo.close();
  });
});

describe('save status', () => {
  it('reports quota failures and does not claim the edit was saved', async () => {
    const queue = new SaveQueue();
    const generation = queue.noteChange();
    expect(queue.status).toBe('dirty');
    await expect(
      queue.enqueue(generation, async () => {
        throw new DOMException('full', 'QuotaExceededError');
      }),
    ).rejects.toThrow();
    expect(queue.status).toBe('local-save-error');
    expect(queue.errorKind).toBe('quota');
  });

  it('shows saved only after the transaction resolves', async () => {
    const queue = new SaveQueue();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generation = queue.noteChange();
    const pending = queue.enqueue(generation, () => gate);
    expect(queue.status).toBe('saving-local');
    release();
    await pending;
    expect(queue.status).toBe('saved-local');
  });
});

describe('history survives reopen', () => {
  it('undoes a stroke after the page is reopened', async () => {
    const repo = ProjectRepository.open('history');
    const created = await repo.create({ name: 'История', width: 4, height: 2 });
    await paintAndSave(repo, created.record.id, 1);
    repo.close();
    const again = ProjectRepository.open('history');
    const loaded = await again.load(created.record.id);
    if (!('doc' in loaded)) throw new Error('load');
    const editor = new EditorSession(loaded.doc, loaded.history, loaded.record.documentRevision);
    expect(editor.doc.cells[1]).toBe(1);
    editor.undo();
    expect(editor.doc.cells[1]).toBe(0);
    editor.redo();
    expect(editor.doc.cells[1]).toBe(1);
    again.close();
  });

  it('drops a corrupt history stack and keeps the picture', () => {
    const doc = createDocument(2, 2);
    doc.cells[0] = 1;
    const editor = new EditorSession(doc, { undo: [], redo: [], notice: 'История не прочитана. Рисунок сохранён.' }, 1);
    expect(editor.doc.cells[0]).toBe(1);
    expect(editor.history.notice).toContain('Рисунок сохранён');
    expect(emptyHistory().undo).toEqual([]);
  });
});

describe('tracing pictures', () => {
  it('keeps a picture with the rug and drops it when the rug is removed', async () => {
    const repo = ProjectRepository.open('traces');
    const created = await repo.create({ name: 'Т', width: 4, height: 4 });
    await repo.putTrace({
      id: 't1',
      projectId: created.record.id,
      blob: new Blob(['img']),
      x: 1,
      y: 2,
      width: 10,
      height: 8,
      rotation: 0.2,
      opacity: 0.5,
      cropX: 0.1,
      cropY: 0,
      cropW: 0.4,
      cropH: 1,
    });
    repo.close();
    const again = ProjectRepository.open('traces');
    const rows = await again.listTraces(created.record.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.opacity).toBe(0.5);
    expect(rows[0]?.cropW).toBe(0.4);
    await again.remove(created.record.id);
    expect(await again.listTraces(created.record.id)).toEqual([]);
    again.close();
  });
});
