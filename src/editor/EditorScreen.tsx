import { useEffect, useRef, useState } from 'react';
import type { EditorPersistPayload, EditorSession } from './session.ts';
import type { ProjectRecord, SymmetryMode, ToolId } from '../model/types.ts';
import { repository } from '../data/instance.ts';
import { registerFlush } from '../app/flush.ts';
import { SaveQueue } from '../data/autosave/queue.ts';
import { resizeDocument, sizeDecision } from './canvas/grid.ts';
import { CanvasView } from './canvas/CanvasView.tsx';
import { EditorSession as Session } from './session.ts';
import { selectionSizeLabel } from './session.ts';
import { slotOf } from './palette/palette.ts';
import { ru } from '../i18n/ru.ts';
import { pngBytes } from '../export/png.ts';
import { exportProjectFile } from '../export/json.ts';
import { enqueueBackup, drainOutbox } from '../backup/outbox.ts';
import { nudgeAxis, snapAxis } from './canvas/coords.ts';
import { axisLabel } from './symmetry/axisLabel.ts';
import { Icon, type IconName } from './icons.tsx';

const tools: { id: ToolId; label: string; icon: IconName }[] = [
  { id: 'pencil', label: ru.pencil, icon: 'pencil' },
  { id: 'eraser', label: ru.eraser, icon: 'eraser' },
  { id: 'fill', label: ru.fill, icon: 'fill' },
  { id: 'picker', label: ru.picker, icon: 'picker' },
  { id: 'line', label: ru.line, icon: 'line' },
  { id: 'circle', label: ru.circle, icon: 'circle' },
  { id: 'rect', label: ru.rect, icon: 'rect' },
  { id: 'diamond', label: ru.diamond, icon: 'diamond' },
  { id: 'select', label: ru.select, icon: 'select' },
  { id: 'pan', label: ru.pan, icon: 'pan' },
];

export function EditorScreen({ id, onBack, onBusy }: { id: string; onBack: () => void; onBusy: (busy: boolean) => void }) {
  const sessionRef = useRef<EditorSession | null>(null);
  const payloadRef = useRef<EditorPersistPayload | null>(null);
  const [queue] = useState(() => new SaveQueue());
  const [session, setSession] = useState<EditorSession | null>(null);
  const [frame, setFrame] = useState(0);
  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localText, setLocalText] = useState<string>(ru.saved);
  const [pngOpen, setPngOpen] = useState(false);
  const [pngGrid, setPngGrid] = useState(false);
  const [pngChecker, setPngChecker] = useState(false);
  const [pngScale, setPngScale] = useState(8);
  const [pngBorder, setPngBorder] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => window.matchMedia('(min-width: 1201px)').matches);
  const [axisSnap, setAxisSnap] = useState<'center' | 'edge'>('edge');
  const [axisLocked, setAxisLocked] = useState(false);
  const [draftHex, setDraftHex] = useState<string | null>(null);
  const colorTimer = useRef(0);
  const refresh = () => setFrame((value) => value + 1);

  useEffect(() => {
    let cancel = false;
    queue.listen(() => {
      setLocalText(queue.status === 'saved-local' ? ru.saved : queue.status === 'saving-local' ? ru.saving : queue.status === 'dirty' ? ru.dirty : ru.saveError);
      if (queue.errorKind === 'quota') setError(ru.quota);
    });
    void repository.load(id).then((loaded) => {
      if (cancel) return;
      if (!('doc' in loaded)) {
        setError(loaded.error);
        return;
      }
      const editor = new Session(loaded.doc, loaded.history, loaded.record.documentRevision);
      editor.onPersist = (payload) => {
        payloadRef.current = payload;
        const generation = queue.noteChange();
        void queue.enqueue(generation, async () => {
          const next = await repository.commit(id, payload);
          if (!cancel) setRecord(next);
        });
      };
      sessionRef.current = editor;
      const xEven = loaded.doc.symmetry.axisX2 % 2 === 0;
      const yEven = loaded.doc.symmetry.axisY2 % 2 === 0;
      if (xEven === yEven) setAxisSnap(xEven ? 'edge' : 'center');
      setSession(editor);
      setRecord(loaded.record);
      if (loaded.history.notice) setError(loaded.history.notice);
      refresh();
    });
    const onHide = () => {
      sessionRef.current?.flushOpenStroke();
      void queue.flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    const unregister = registerFlush(async () => {
      sessionRef.current?.pointerUp();
      sessionRef.current?.flushOpenStroke();
      await queue.flush();
    });
    return () => {
      cancel = true;
      unregister();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [id]);

  useEffect(() => {
    onBusy(Boolean(sessionRef.current?.gesture));
  }, [frame, onBusy]);

  useEffect(() => {
    const editor = sessionRef.current;
    if (!editor || !record) return;
    const timer = window.setTimeout(() => {
      void backupNow(record, editor);
    }, 15_000);
    const onLine = () => {
      void backupNow(record, editor);
    };
    window.addEventListener('online', onLine);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('online', onLine);
    };
  }, [record]);

  if (!session || !record) {
    return <p className="status">{error ?? ru.saving}</p>;
  }

  const saveView = () => {
    session.setView({
      gridVisible: session.doc.gridVisible,
      checkerVisible: session.doc.checkerVisible,
      checkerBlock: session.doc.checkerBlock,
      symmetry: session.doc.symmetry,
    });
    refresh();
  };

  const chooseSnap = (mode: 'center' | 'edge') => {
    setAxisSnap(mode);
    session.doc.symmetry = {
      ...session.doc.symmetry,
      axisX2: clampAxis(snapAxis(session.doc.symmetry.axisX2, mode), session.doc.width),
      axisY2: clampAxis(snapAxis(session.doc.symmetry.axisY2, mode), session.doc.height),
    };
    saveView();
  };
  const live = session.liveSelection();

  return (
    <div className={`editor${panelOpen ? ' panel-open' : ''}`}>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label={ru.back} title={ru.back} onClick={() => leave(session, queue, onBack)}>
          <Icon name="chevronLeft" />
        </button>
        <strong className="project-name">{record.name}</strong>
        <span className="project-size">{session.doc.width} × {session.doc.height}</span>
        <span className="top-spacer" />
        <span className={`status-icon ${localClass(localText)}`} title={localText} aria-label={localText}>
          <Icon name={localText === ru.saveError ? 'alert' : localText === ru.saved ? 'check' : 'retry'} />
        </span>
        <span className={`status-icon ${cloudClass(record.syncState)}`} title={backupLabel(record.syncState)} aria-label={backupLabel(record.syncState)}>
          <Icon name="cloud" />
        </span>
        {localText === ru.saveError ? (
          <button type="button" className="icon-btn" aria-label={ru.retry} title={ru.retry} onClick={() => retry(queue, payloadRef.current, id, setRecord)}><Icon name="retry" /></button>
        ) : null}
        <button type="button" className="icon-btn" aria-label={ru.undo} title={ru.undo} onClick={() => { session.undo(); refresh(); }}>
          <Icon name="undo" />
        </button>
        <button type="button" className="icon-btn" aria-label={ru.redo} title={ru.redo} onClick={() => { session.redo(); refresh(); }}>
          <Icon name="redo" />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={panelOpen ? ru.collapsePanel : ru.expandPanel}
          title={panelOpen ? ru.collapsePanel : ru.expandPanel}
          aria-pressed={panelOpen}
          onClick={() => setPanelOpen((open) => !open)}
        >
          <Icon name="panel" />
        </button>
      </header>
      <nav className="tools" aria-label={ru.tools}>
        {tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className="icon-btn tool"
            aria-label={tool.label}
            title={tool.label}
            aria-pressed={session.tool === tool.id}
            onClick={() => { session.setTool(tool.id); refresh(); }}
          >
            <Icon name={tool.icon} />
          </button>
        ))}
      </nav>
      <div className="stage">
        <CanvasView session={session} frame={frame} axisSnap={axisSnap} axisLocked={axisLocked} onChange={refresh} />
      </div>
      <button type="button" className="scrim" aria-label={ru.closePanel} onClick={() => setPanelOpen(false)} />
      <aside className="side" inert={!panelOpen}>
        {error ? <p className="warning">{error}</p> : null}
        <section className="group" aria-label={ru.display}>
          <div className="icon-row">
            <label className="tick" title={ru.grid}>
              <input type="checkbox" checked={session.doc.gridVisible} aria-label={ru.grid} onChange={(event) => { session.doc.gridVisible = event.target.checked; saveView(); }} />
              <Icon name="grid" />
            </label>
            <label className="tick" title={ru.checker}>
              <input type="checkbox" checked={session.doc.checkerVisible} aria-label={ru.checker} onChange={(event) => { session.doc.checkerVisible = event.target.checked; saveView(); }} />
              <Icon name="checker" />
            </label>
            <button type="button" className="icon-btn" aria-label={ru.checkerLess} title={ru.checkerLess} disabled={session.doc.checkerBlock <= 1} onClick={() => { session.doc.checkerBlock = Math.max(1, session.doc.checkerBlock - 1); saveView(); }}><Icon name="minus" /></button>
            <span className="step-value" aria-live="polite">{session.doc.checkerBlock}</span>
            <button type="button" className="icon-btn" aria-label={ru.checkerMore} title={ru.checkerMore} disabled={session.doc.checkerBlock >= 32} onClick={() => { session.doc.checkerBlock = Math.min(32, session.doc.checkerBlock + 1); saveView(); }}><Icon name="plus" /></button>
          </div>
        </section>
        <section className="group" aria-label={ru.symmetry}>
          <div className="icon-row">
            <label className="tick" title={ru.symmetryVertical}>
              <input
                type="checkbox"
                checked={session.doc.symmetry.mode === 'vertical' || session.doc.symmetry.mode === 'both'}
                aria-label={ru.symmetryVertical}
                onChange={(event) => setSymmetry(session, event.target.checked, session.doc.symmetry.mode === 'horizontal' || session.doc.symmetry.mode === 'both', saveView)}
              />
              <Icon name="axisV" />
            </label>
            <label className="tick" title={ru.symmetryHorizontal}>
              <input
                type="checkbox"
                checked={session.doc.symmetry.mode === 'horizontal' || session.doc.symmetry.mode === 'both'}
                aria-label={ru.symmetryHorizontal}
                onChange={(event) => setSymmetry(session, session.doc.symmetry.mode === 'vertical' || session.doc.symmetry.mode === 'both', event.target.checked, saveView)}
              />
              <Icon name="axisH" />
            </label>
            <button
              type="button"
              className="icon-btn"
              aria-label={axisLocked ? ru.axisUnlock : ru.axisLock}
              title={axisLocked ? ru.axisUnlock : ru.axisLock}
              aria-pressed={axisLocked}
              onClick={() => setAxisLocked((locked) => !locked)}
            >
              <Icon name={axisLocked ? 'lock' : 'unlock'} />
            </button>
          </div>
          <div className="icon-row">
            <button type="button" className="icon-btn" aria-label={ru.nudgeLeft} title={ru.nudgeLeft} disabled={axisLocked} onClick={() => nudge(session, 'axisX2', -1, axisSnap, saveView)}><Icon name="chevronLeft" /></button>
            <button type="button" className="icon-btn" aria-label={ru.nudgeRight} title={ru.nudgeRight} disabled={axisLocked} onClick={() => nudge(session, 'axisX2', 1, axisSnap, saveView)}><Icon name="chevronRight" /></button>
            <button type="button" className="icon-btn" aria-label={ru.nudgeUp} title={ru.nudgeUp} disabled={axisLocked} onClick={() => nudge(session, 'axisY2', -1, axisSnap, saveView)}><Icon name="chevronUp" /></button>
            <button type="button" className="icon-btn" aria-label={ru.nudgeDown} title={ru.nudgeDown} disabled={axisLocked} onClick={() => nudge(session, 'axisY2', 1, axisSnap, saveView)}><Icon name="chevronDown" /></button>
          </div>
          <div className="icon-row">
            <button type="button" className="icon-btn" aria-label={ru.snapEdge} title={ru.snapEdge} aria-pressed={axisSnap === 'edge'} disabled={axisLocked} onClick={() => chooseSnap('edge')}><Icon name="snapEdge" /></button>
            <button type="button" className="icon-btn" aria-label={ru.snapCenter} title={ru.snapCenter} aria-pressed={axisSnap === 'center'} disabled={axisLocked} onClick={() => chooseSnap('center')}><Icon name="snapCenter" /></button>
            <button type="button" className="icon-btn" aria-label={ru.centerAxes} title={ru.centerAxes} disabled={axisLocked} onClick={() => centerAxes(session, axisSnap, saveView)}><Icon name="crosshair" /></button>
          </div>
          <p className="axis-coords" title={`${axisLabel(session.doc.symmetry.axisX2, session.doc.width, true)}. ${axisLabel(session.doc.symmetry.axisY2, session.doc.height, false)}`}>
            {shortAxis(session.doc.symmetry.axisX2, session.doc.width)} · {shortAxis(session.doc.symmetry.axisY2, session.doc.height)}
          </p>
        </section>
        <section className="group" aria-label={ru.selection}>
          {live ? <p className="note">{selectionSizeLabel(live)}</p> : null}
          {session.notice ? <p className="note">{session.notice}</p> : null}
          {session.pasteClipped ? <p className="note">{ru.clipped}</p> : null}
          <div className="icon-row">
            <button type="button" className="icon-btn" aria-label={ru.copy} title={ru.copy} disabled={!session.selection} onClick={() => { session.copySelection(); refresh(); }}><Icon name="copy" /></button>
            <button type="button" className="icon-btn" aria-label={ru.paste} title={ru.paste} disabled={!session.clipboard} onClick={() => { session.beginPaste(); refresh(); }}><Icon name="paste" /></button>
          </div>
        </section>
        <section className="group" aria-label={ru.palette}>
          <div className="palette" aria-label={ru.palette}>
            <label className="wheel" title={ru.pickColor}>
              <input
                type="color"
                aria-label={ru.pickColor}
                value={draftHex ?? session.doc.palette[session.colorSlot - 1]?.hex ?? '#1a1614'}
                onChange={(event) => {
                  const hex = event.target.value;
                  setDraftHex(hex);
                  window.clearTimeout(colorTimer.current);
                  colorTimer.current = window.setTimeout(() => {
                    session.useColor(hex);
                    setDraftHex(null);
                    refresh();
                  }, 300);
                }}
              />
            </label>
            {session.doc.palette.map((color, index) => (
              <button
                key={color.id}
                type="button"
                className="swatch"
                style={{ background: color.hex }}
                aria-label={color.hex}
                title={color.hex}
                aria-pressed={session.colorSlot === slotOf(index)}
                onClick={() => { session.setColorSlot(slotOf(index)); refresh(); }}
              />
            ))}
          </div>
        </section>
        <section className="group" aria-label={ru.project}>
          <ResizeForm session={session} onDone={refresh} />
          <div className="icon-row">
            <button type="button" className="icon-btn" aria-label={ru.exportPng} title={ru.exportPng} onClick={() => setPngOpen(true)}><Icon name="image" /></button>
            <button type="button" className="icon-btn" aria-label={ru.exportJson} title={ru.exportJson} onClick={() => download(new TextEncoder().encode(exportProjectFile(record.id, record.name, session.doc)), `${record.name}.json`, 'application/json')}><Icon name="file" /></button>
            <button type="button" className="icon-btn" aria-label={ru.backupRetry} title={ru.backupRetry} onClick={() => void backupNow(record, session)}><Icon name="cloud" /></button>
          </div>
        </section>
      </aside>
      {pngOpen ? (
        <dialog open className="sheet">
          <label className="check"><input type="checkbox" checked={pngGrid} onChange={(event) => setPngGrid(event.target.checked)} />{ru.grid}</label>
          <label className="check"><input type="checkbox" checked={pngChecker} onChange={(event) => setPngChecker(event.target.checked)} />{ru.checker}</label>
          <label className="check"><input type="checkbox" checked={pngBorder} onChange={(event) => setPngBorder(event.target.checked)} />{ru.border}</label>
          <label>{ru.pixelsPerCell}<input type="number" min={1} max={64} value={pngScale} onChange={(event) => setPngScale(Number(event.target.value) || 1)} /></label>
          <button type="button" onClick={() => {
            const bytes = pngBytes(session.doc, { grid: pngGrid, checker: pngChecker, pixelsPerCell: pngScale, border: pngBorder, checkerBlock: session.doc.checkerBlock });
            download(bytes, `${record.name}.png`, 'image/png');
          }}>{ru.download}</button>
          <button type="button" onClick={() => setPngOpen(false)}>{ru.close}</button>
        </dialog>
      ) : null}
    </div>
  );
}

function ResizeForm({ session, onDone }: { session: EditorSession; onDone: () => void }) {
  const [width, setWidth] = useState(session.doc.width);
  const [height, setHeight] = useState(session.doc.height);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const decision = sizeDecision(width, height, deviceMemory());
        if (decision === 'reject') return;
        const resized = resizeDocument(session.doc, width, height);
        if (!resized) return;
        if (resized.cropped && !window.confirm(ru.crop)) return;
        if (decision === 'confirm' && !window.confirm(ru.largeCanvas)) return;
        session.replaceDocument(resized.doc);
        onDone();
      }}
    >
      <div className="icon-row">
        <input className="mini" type="number" min={1} max={4000} aria-label={ru.width} title={ru.width} value={width} onChange={(event) => setWidth(Number(event.target.value))} />
        <input className="mini" type="number" min={1} max={4000} aria-label={ru.height} title={ru.height} value={height} onChange={(event) => setHeight(Number(event.target.value))} />
        <button type="submit" className="icon-btn" aria-label={ru.applySize} title={ru.applySize}><Icon name="check" /></button>
      </div>
    </form>
  );
}

function nudge(
  session: EditorSession,
  key: 'axisX2' | 'axisY2',
  direction: number,
  mode: 'center' | 'edge',
  done: () => void,
): void {
  const edge = key === 'axisX2' ? session.doc.width : session.doc.height;
  const snapped = snapAxis(session.doc.symmetry[key], mode);
  const next = clampAxis(snapAxis(nudgeAxis(snapped, direction * 2, edge), mode), edge);
  session.doc.symmetry = { ...session.doc.symmetry, [key]: next };
  done();
}

function centerAxes(session: EditorSession, mode: 'center' | 'edge', done: () => void): void {
  session.doc.symmetry = {
    ...session.doc.symmetry,
    axisX2: clampAxis(snapAxis(session.doc.width, mode), session.doc.width),
    axisY2: clampAxis(snapAxis(session.doc.height, mode), session.doc.height),
  };
  done();
}

function setSymmetry(session: EditorSession, vertical: boolean, horizontal: boolean, saveView: () => void): void {
  const mode: SymmetryMode = vertical && horizontal ? 'both' : vertical ? 'vertical' : horizontal ? 'horizontal' : 'off';
  session.doc.symmetry = { ...session.doc.symmetry, mode };
  saveView();
}

function shortAxis(axis2: number, edge: number): string {
  if (axis2 % 2 === 0) {
    const n = axis2 / 2;
    if (n <= 0) return '0';
    if (n >= edge) return String(edge);
    return `${n}–${n + 1}`;
  }
  return String(Math.ceil(axis2 / 2));
}

function clampAxis(axis2: number, edge: number): number {
  return Math.max(0, Math.min(edge * 2, axis2));
}

function retry(
  queue: SaveQueue,
  payload: EditorPersistPayload | null,
  id: string,
  setRecord: (record: ProjectRecord) => void,
): void {
  if (!payload) return;
  const generation = queue.noteChange();
  void queue.enqueue(generation, async () => {
    setRecord(await repository.commit(id, payload));
  });
}

async function leave(session: EditorSession, queue: SaveQueue, onBack: () => void): Promise<void> {
  session.pointerUp();
  await queue.flush();
  onBack();
}

function localClass(text: string): string {
  if (text === ru.saved) return 'status ok';
  if (text === ru.saveError) return 'status bad';
  return 'status wait';
}

function cloudClass(state: ProjectRecord['syncState']): string {
  if (state === 'backed-up') return 'status ok';
  if (state === 'error' || state === 'conflict') return 'status bad';
  if (state === 'pending' || state === 'uploading') return 'status wait';
  return 'status muted';
}

function backupLabel(state: ProjectRecord['syncState']): string {
  if (state === 'pending') return ru.backupPending;
  if (state === 'uploading') return ru.backupUploading;
  if (state === 'backed-up') return ru.backupOk;
  if (state === 'error') return ru.backupError;
  if (state === 'conflict') return ru.backupConflict;
  return ru.backupOff;
}

async function backupNow(record: ProjectRecord, session: EditorSession): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const ownerId = await repository.readMeta<string>('backupUserId');
  const enabled = await repository.readMeta<boolean>('backupEnabled');
  if (!url || !publishableKey || !ownerId || !enabled || session.gesture || !navigator.onLine) return;
  if (record.syncState === 'backed-up' && record.documentRevision === session.revision) return;
  await enqueueBackup(repository, { ...record, documentRevision: session.revision });
  const { createSupabaseTransport } = await import('../backup/supabase/adapter.ts');
  const transport = await createSupabaseTransport({ url, publishableKey, ownerId });
  await drainOutbox(repository, transport, ownerId, new Date().toISOString());
}

function download(bytes: Uint8Array, name: string, type: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function deviceMemory(): number | undefined {
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === 'number' ? value : undefined;
}
