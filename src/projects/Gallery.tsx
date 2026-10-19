import { useEffect, useRef, useState } from 'react';
import type { RugRow } from '../backup/protocol.ts';
import { documentFromRow } from '../backup/restore.ts';
import { forgetDeleted, rememberDeleted, syncAccount } from '../backup/outbox.ts';
import { repository } from '../data/instance.ts';
import { requestPersistentStorage, storageIsPersisted } from '../data/storage.ts';
import { sizeDecision } from '../editor/canvas/grid.ts';
import { emptyHistory } from '../editor/history/patches.ts';
import { rugPreview } from '../export/png.ts';
import { ru } from '../i18n/ru.ts';
import type { ProjectRecord } from '../model/types.ts';

export function Gallery({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [name, setName] = useState('Новый ковёр');
  const [width, setWidth] = useState(100);
  const [height, setHeight] = useState(100);
  const [message, setMessage] = useState<string | null>(null);
  const [storageText, setStorageText] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [versions, setVersions] = useState<RugRow[]>([]);
  const [compare, setCompare] = useState('');
  const [backupOn, setBackupOn] = useState(false);
  const [account, setAccount] = useState<{ id: string; email: string } | null | undefined>(undefined);
  const [authOpen, setAuthOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [trash, setTrash] = useState<ProjectRecord[]>([]);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const configured = Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);

  async function reload(): Promise<void> {
    setProjects(await repository.list());
    setTrash(await repository.listDeleted());
    setArmedDelete(null);
  }

  useEffect(() => {
    void reload();
    void repository.readMeta<boolean>('backupEnabled').then((value) => setBackupOn(Boolean(value)));
    void restoreSession(setAccount, setBackupOn, reload);
  }, []);

  return (
    <main className="gallery">
      <header className="gallery-head">
        <div>
          <h1>{ru.galleryTitle}</h1>
          <p>{ru.appName}</p>
        </div>
        {configured && account ? (
          <div className="who">
            <span title={account.email}>{account.email}</span>
            <label className="check" title={ru.backupToggle}>
              <input
                type="checkbox"
                checked={backupOn}
                aria-label={ru.backupToggle}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setBackupOn(enabled);
                  void repository.writeMeta('backupEnabled', enabled).then(() => {
                    if (enabled) return syncIfEnabled(reload);
                  });
                }}
              />
              {ru.backupToggle}
            </label>
            <button type="button" onClick={() => void signOutAccount(setAccount)}>{ru.signOut}</button>
          </div>
        ) : null}
        {configured && account === null ? (
          <button type="button" onClick={() => setAuthOpen((open) => !open)}>{ru.signIn}</button>
        ) : null}
      </header>
      {message ? <p className="warning">{message}</p> : null}
      {configured && account === null && authOpen ? (
        <form
          className="auth"
          onSubmit={(event) => {
            event.preventDefault();
            void signIn(email, password, setMessage, setAccount, setBackupOn, setAuthOpen, reload);
          }}
        >
          <label>{ru.email}<input type="email" value={email} autoComplete="username" onChange={(event) => setEmail(event.target.value)} /></label>
          <label>{ru.password}<input type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} /></label>
          <button type="submit">{ru.signIn}</button>
        </form>
      ) : null}
      {configured ? null : <p>{ru.backupOff}</p>}
      {createOpen ? (
        <form
          className="create"
          onSubmit={(event) => {
            event.preventDefault();
            void createProject(name, width, height, setMessage, setCreateOpen, reload);
          }}
        >
          <label>{ru.name}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>{ru.width}<input type="number" min={1} max={4000} value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
          <label>{ru.height}<input type="number" min={1} max={4000} value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
          <button type="submit">{ru.create}</button>
        </form>
      ) : (
        <button type="button" onClick={() => setCreateOpen(true)}>{ru.create}</button>
      )}
      {projects.length === 0 ? <p className="empty">{ru.empty}</p> : null}
      <ul className="shelf">
        {projects.map((project) => (
          <li key={project.id} className="rug">
            <button type="button" className="rug-open" onClick={() => onOpen(project.id)}>
              <Preview id={project.id} />
              <strong>{project.name}</strong>
              <span>{project.width} × {project.height} {ru.cells}</span>
              <span>{new Date(project.updatedAt).toLocaleString('ru')}</span>
              <span>{backupText(project.syncState)}</span>
            </button>
            <div className="row">
              <button type="button" onClick={() => void rename(project, reload)}>{ru.rename}</button>
              <button type="button" onClick={() => void repository.duplicate(project.id).then(() => reload())}>{ru.duplicate}</button>
              {armedDelete === project.id ? (
                <>
                  <button type="button" onClick={() => void remove(project, reload)}>{ru.deleteConfirm}</button>
                  <button type="button" onClick={() => setArmedDelete(null)}>{ru.cancel}</button>
                </>
              ) : (
                <button type="button" onClick={() => setArmedDelete(project.id)}>{ru.remove}</button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {trash.length > 0 ? (
        <section className="trash">
          <h2>{ru.deletedRugs}</h2>
          <ul>
            {trash.map((project) => (
              <li key={project.id}>
                <span>{project.name}</span>
                <span>{project.width} × {project.height}</span>
                <button type="button" onClick={() => void restoreRug(project, reload)}>{ru.restoreRug}</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="diagnostics">
        <h2>{ru.diagnostics}</h2>
        <button type="button" onClick={() => void showStorage(setStorageText)}>{ru.persistAsk}</button>
        {storageText ? <p>{storageText}</p> : null}
        {configured ? <button type="button" onClick={() => void loadVersions(setVersions, setMessage)}>{ru.showBackups}</button> : null}
        {compare ? <p>{compare}</p> : null}
        <ul>
          {versions.map((version) => (
            <li key={version.id}>
              <span>{version.name}</span>
              <span>{new Date(version.updatedAt).toLocaleString('ru')}</span>
              <span>{version.width} × {version.height}</span>
              <span>ревизия {version.documentRevision}</span>
              <button type="button" onClick={() => void restore(version, setMessage, reload)}>{ru.restoreNew}</button>
              <button type="button" onClick={() => setCompare(`${ru.compare}: ${version.updatedAt}, ревизия ${version.documentRevision}`)}>{ru.compare}</button>
              <button type="button" onClick={() => setMessage(ru.keepBoth)}>{ru.keepBoth}</button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function backupText(state: ProjectRecord['syncState']): string {
  if (state === 'backed-up') return ru.backupOk;
  if (state === 'pending' || state === 'uploading') return ru.backupPending;
  if (state === 'error') return ru.backupError;
  if (state === 'conflict') return ru.backupConflict;
  return ru.backupOff;
}

function Preview({ id }: { id: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let gone = false;
    void repository.load(id).then((loaded) => {
      if (gone || !canvas.isConnected || !('doc' in loaded)) return;
      const measured = canvas.parentElement?.clientWidth ?? 0;
      const image = rugPreview(loaded.doc, measured > 0 ? measured : 216);
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    });
    return () => {
      gone = true;
    };
  }, [id]);
  return <canvas ref={canvasRef} className="preview" width={1} height={1} aria-hidden="true" />;
}

async function createProject(
  name: string,
  width: number,
  height: number,
  setMessage: (value: string | null) => void,
  setCreateOpen: (value: boolean) => void,
  reload: () => Promise<void>,
): Promise<void> {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const decision = sizeDecision(width, height, typeof memory === 'number' ? memory : undefined);
  if (decision === 'reject') {
    setMessage(ru.largeCanvas);
    return;
  }
  if (decision === 'confirm' && !window.confirm(ru.largeCanvas)) return;
  await repository.create({ name, width, height });
  setMessage(null);
  setCreateOpen(false);
  await reload();
}

async function rename(project: ProjectRecord, reload: () => Promise<void>): Promise<void> {
  const name = window.prompt(ru.rename, project.name);
  if (!name) return;
  await repository.rename(project.id, name);
  await reload();
}

async function remove(project: ProjectRecord, reload: () => Promise<void>): Promise<void> {
  if (!window.confirm(ru.deleteRug)) return;
  await repository.markDeleted(project.id, new Date().toISOString());
  await rememberDeleted(repository, project.id);
  await reload();
  await syncIfEnabled(reload);
}

async function restoreRug(project: ProjectRecord, reload: () => Promise<void>): Promise<void> {
  await forgetDeleted(repository, project.id);
  await repository.markDeleted(project.id, null);
  await reload();
  await syncIfEnabled(reload);
}

async function showStorage(setStorageText: (value: string) => void): Promise<void> {
  const granted = await requestPersistentStorage();
  const persisted = await storageIsPersisted();
  setStorageText(persisted || granted ? ru.persistOn : ru.persistOff);
}

async function restoreSession(
  setAccount: (user: { id: string; email: string } | null) => void,
  setBackupOn: (value: boolean) => void,
  reload: () => Promise<void>,
): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    setAccount(null);
    return;
  }
  const { currentSession } = await import('../backup/supabase/adapter.ts');
  let user: { id: string; email: string } | null = null;
  try {
    user = await currentSession({ url, publishableKey });
  } catch {
    user = null;
  }
  setAccount(user);
  if (!user) return;
  await repository.writeMeta('backupUserId', user.id);
  const enabled = await repository.readMeta<boolean>('backupEnabled');
  if (enabled) {
    setBackupOn(true);
    await syncIfEnabled(reload);
  }
}

async function signOutAccount(setAccount: (user: null) => void): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return;
  const { signOut } = await import('../backup/supabase/adapter.ts');
  await signOut({ url, publishableKey });
  await repository.writeMeta('backupUserId', null);
  setAccount(null);
}

async function signIn(
  email: string,
  password: string,
  setMessage: (value: string | null) => void,
  setAccount: (user: { id: string; email: string } | null) => void,
  setBackupOn: (value: boolean) => void,
  setAuthOpen: (value: boolean) => void,
  reload: () => Promise<void>,
): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return;
  const { signIn: signInUser } = await import('../backup/supabase/adapter.ts');
  const user = await signInUser({ url, publishableKey, ownerId: 'pending' }, email, password);
  if (!user) {
    setMessage(ru.signInFailed);
    return;
  }
  await repository.writeMeta('backupUserId', user.id);
  await repository.writeMeta('backupEnabled', true);
  setAccount(user);
  setBackupOn(true);
  setAuthOpen(false);
  setMessage(null);
  await syncIfEnabled(reload);
}

async function syncIfEnabled(reload: () => Promise<void>): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const ownerId = await repository.readMeta<string>('backupUserId');
  const enabled = await repository.readMeta<boolean>('backupEnabled');
  if (!url || !publishableKey || !ownerId || !enabled || !navigator.onLine) return;
  const { createSupabaseTransport } = await import('../backup/supabase/adapter.ts');
  const transport = await createSupabaseTransport({ url, publishableKey, ownerId });
  await syncAccount(repository, transport, ownerId, new Date().toISOString());
  await reload();
}

async function loadVersions(setVersions: (versions: RugRow[]) => void, setMessage: (value: string | null) => void): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const ownerId = await repository.readMeta<string>('backupUserId');
  if (!url || !publishableKey || !ownerId) {
    setMessage(ru.backupOff);
    return;
  }
  const { createSupabaseTransport } = await import('../backup/supabase/adapter.ts');
  const transport = await createSupabaseTransport({ url, publishableKey, ownerId });
  setVersions(await transport.list());
}

async function restore(version: RugRow, setMessage: (value: string | null) => void, reload: () => Promise<void>): Promise<void> {
  const doc = await documentFromRow(version);
  if (!doc) {
    setMessage('Строка в базе не прошла проверку. Существующие ковры не изменены.');
    return;
  }
  const created = await repository.create({ name: version.name, width: doc.width, height: doc.height });
  await repository.commit(created.record.id, {
    doc,
    history: emptyHistory(),
    patches: [],
    opNumber: created.record.documentRevision,
    type: 'restore',
  });
  setMessage(ru.restoreNew);
  await reload();
}
