import { useEffect, useState } from 'react';
import type { RugRow } from '../backup/protocol.ts';
import { documentFromRow } from '../backup/restore.ts';
import { syncAccount } from '../backup/outbox.ts';
import { repository } from '../data/instance.ts';
import { requestPersistentStorage, storageEstimate, storageIsPersisted } from '../data/storage.ts';
import { createDocument, sizeDecision } from '../editor/canvas/grid.ts';
import { emptyHistory } from '../editor/history/patches.ts';
import { parseProjectFile } from '../export/json.ts';
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
  const configured = Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);

  async function reload(): Promise<void> {
    setProjects(await repository.list());
  }

  useEffect(() => {
    void reload().then(() => syncIfEnabled(reload));
  }, []);

  return (
    <main className="gallery">
      <header className="gallery-head">
        <h1>{ru.galleryTitle}</h1>
        <p>{ru.appName}</p>
      </header>
      {message ? <p className="warning">{message}</p> : null}
      <form
        className="create"
        onSubmit={(event) => {
          event.preventDefault();
          void createProject(name, width, height, setMessage, reload);
        }}
      >
        <label>{ru.name}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>{ru.width}<input type="number" min={1} max={4000} value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
        <label>{ru.height}<input type="number" min={1} max={4000} value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
        <button type="submit">{ru.create}</button>
      </form>
      {projects.length === 0 ? <p className="empty">{ru.empty}</p> : null}
      <ul className="shelf">
        {projects.map((project) => (
          <li key={project.id} className="rug">
            <button type="button" className="rug-open" onClick={() => onOpen(project.id)}>
              <Preview id={project.id} />
              <span className="fringe" />
              <strong>{project.name}</strong>
              <span>{project.width} × {project.height} {ru.cells}</span>
              <span>{new Date(project.updatedAt).toLocaleString('ru')}</span>
              <span>{project.lastCloudBackupAt ? ru.backupOk : ru.backupOff}</span>
            </button>
            <div className="row">
              <button type="button" onClick={() => void rename(project, reload)}>{ru.rename}</button>
              <button type="button" onClick={() => void repository.duplicate(project.id).then(() => reload())}>{ru.duplicate}</button>
              <button type="button" onClick={() => void remove(project, reload)}>{ru.remove}</button>
            </div>
          </li>
        ))}
      </ul>
      <section className="diagnostics">
        <h2>{ru.diagnostics}</h2>
        <button type="button" onClick={() => void showStorage(setStorageText)}>{ru.persistAsk}</button>
        {storageText ? <p>{storageText}</p> : null}
        <label className="file">
          {ru.importJson}
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importJson(file, setMessage, reload);
            }}
          />
        </label>
        {configured ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void signIn(email, password, setMessage);
            }}
          >
            <h2>{ru.signIn}</h2>
            <label>{ru.email}<input type="email" value={email} autoComplete="username" onChange={(event) => setEmail(event.target.value)} /></label>
            <label>{ru.password}<input type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} /></label>
            <button type="submit">{ru.signIn}</button>
            <label className="check">
              <input
                type="checkbox"
                onChange={(event) => {
                  void repository.writeMeta('backupEnabled', event.target.checked);
                }}
              />
              {ru.backupToggle}
            </label>
            <button type="button" onClick={() => void loadVersions(setVersions, setMessage)}>{ru.showBackups}</button>
          </form>
        ) : <p>{ru.backupOff}</p>}
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

function Preview({ id }: { id: string }) {
  const [colors, setColors] = useState<string[]>([]);
  useEffect(() => {
    void repository.load(id).then((loaded) => {
      if (!('doc' in loaded)) return;
      const next: string[] = [];
      const stepX = Math.max(1, Math.floor(loaded.doc.width / 12));
      const stepY = Math.max(1, Math.floor(loaded.doc.height / 8));
      for (let y = 0; y < loaded.doc.height; y += stepY) {
        for (let x = 0; x < loaded.doc.width; x += stepX) {
          const slot = loaded.doc.cells[y * loaded.doc.width + x] ?? 0;
          next.push(slot === 0 ? 'transparent' : loaded.doc.palette[slot - 1]?.hex ?? 'transparent');
        }
      }
      setColors(next);
    });
  }, [id]);
  return (
    <span className="preview" aria-hidden="true">
      {colors.map((color, index) => <i key={index} style={{ background: color }} />)}
    </span>
  );
}

async function createProject(
  name: string,
  width: number,
  height: number,
  setMessage: (value: string | null) => void,
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
  await reload();
}

async function rename(project: ProjectRecord, reload: () => Promise<void>): Promise<void> {
  const name = window.prompt(ru.rename, project.name);
  if (!name) return;
  await repository.rename(project.id, name);
  await reload();
}

async function remove(project: ProjectRecord, reload: () => Promise<void>): Promise<void> {
  const agreed = window.confirm(project.lastCloudBackupAt ? ru.keepCloud : ru.noCloud);
  if (!agreed) return;
  await repository.remove(project.id);
  await reload();
}

async function importJson(file: File, setMessage: (value: string | null) => void, reload: () => Promise<void>): Promise<void> {
  const parsed = parseProjectFile(await file.text());
  if (!parsed.ok) {
    setMessage(parsed.error);
    return;
  }
  const created = await repository.create({ name: parsed.file.name, width: parsed.file.width, height: parsed.file.height });
  const doc = createDocument(parsed.file.width, parsed.file.height, parsed.file.palette);
  doc.cells = parsed.cells;
  doc.gridVisible = parsed.file.gridVisible;
  doc.checkerVisible = parsed.file.checkerVisible;
  doc.checkerBlock = parsed.file.checkerBlock;
  doc.symmetry = parsed.file.symmetry;
  await repository.commit(created.record.id, {
    doc,
    history: emptyHistory(),
    patches: [],
    opNumber: created.record.documentRevision,
    type: 'import',
  });
  setMessage(null);
  await reload();
}

async function showStorage(setStorageText: (value: string) => void): Promise<void> {
  const granted = await requestPersistentStorage();
  const persisted = await storageIsPersisted();
  const estimate = await storageEstimate();
  const quota = estimate ? `${Math.round(estimate.usage / 1024)} / ${Math.round(estimate.quota / 1024)} КБ` : '';
  setStorageText(`${persisted || granted ? ru.persistOn : ru.persistOff} ${quota} ${ru.persistNote}`);
}

async function signIn(email: string, password: string, setMessage: (value: string | null) => void): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return;
  const { signIn: signInUser } = await import('../backup/supabase/adapter.ts');
  const userId = await signInUser({ url, anonKey, ownerId: 'pending' }, email, password);
  if (!userId) {
    setMessage(ru.signInFailed);
    return;
  }
  await repository.writeMeta('backupUserId', userId);
  setMessage(null);
}

async function syncIfEnabled(reload: () => Promise<void>): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const ownerId = await repository.readMeta<string>('backupUserId');
  const enabled = await repository.readMeta<boolean>('backupEnabled');
  if (!url || !anonKey || !ownerId || !enabled || !navigator.onLine) return;
  const { createSupabaseTransport } = await import('../backup/supabase/adapter.ts');
  const transport = await createSupabaseTransport({ url, anonKey, ownerId });
  await syncAccount(repository, transport, ownerId, new Date().toISOString());
  await reload();
}

async function loadVersions(setVersions: (versions: RugRow[]) => void, setMessage: (value: string | null) => void): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const ownerId = await repository.readMeta<string>('backupUserId');
  if (!url || !anonKey || !ownerId) {
    setMessage(ru.backupOff);
    return;
  }
  const { createSupabaseTransport } = await import('../backup/supabase/adapter.ts');
  const transport = await createSupabaseTransport({ url, anonKey, ownerId });
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
