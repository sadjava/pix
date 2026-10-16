import { useEffect, useRef, useState } from 'react';
import type { EditorPersistPayload, EditorSession } from './session.ts';
import type { PaletteColor, ProjectRecord, SymmetryMode, ToolId } from '../model/types.ts';
import { repository } from '../data/instance.ts';
import { registerFlush } from '../app/flush.ts';
import { SaveQueue } from '../data/autosave/queue.ts';
import { resizeDocument, sizeDecision } from './canvas/grid.ts';
import { CanvasView } from './canvas/CanvasView.tsx';
import { EditorSession as Session } from './session.ts';
import { selectionSizeLabel } from './session.ts';
import { normalizeHex, slotOf, colorUsed } from './palette/palette.ts';
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

const symmetryModes: { id: SymmetryMode; label: string }[] = [
  { id: 'off', label: ru.symmetryOff },
  { id: 'vertical', label: ru.symmetryVertical },
  { id: 'horizontal', label: ru.symmetryHorizontal },
  { id: 'both', label: ru.symmetryBoth },
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
  const [hex, setHex] = useState('#9e2a2b');
  const [colorName, setColorName] = useState('Нить');
  const [replaceSlot, setReplaceSlot] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(() => window.matchMedia('(min-width: 861px)').matches);
  const [axisSnap, setAxisSnap] = useState<'center' | 'edge'>('edge');
  const refresh = () => setFrame((value) => value + 1);
  const colorSlot = session?.colorSlot ?? 0;

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
    if (!editor) return;
    const color = editor.doc.palette[editor.colorSlot - 1];
    if (!color) return;
    setHex(color.hex);
    setColorName(color.name);
  }, [colorSlot]);

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

  return (
    <div className={`editor${toolsOpen ? '' : ' is-tools-hidden'}${panelOpen ? ' panel-open' : ''}`}>
      <header className="topbar">
        <button type="button" className="icon-btn back" onClick={() => leave(session, queue, onBack)}>
          <Icon name="chevronLeft" />
          {ru.back}
        </button>
        {!toolsOpen ? (
          <button type="button" className="icon-btn" aria-label={ru.expandTools} title={ru.expandTools} onClick={() => setToolsOpen(true)}>
            <Icon name="chevronRight" />
          </button>
        ) : null}
        <strong className="project-name">{record.name}</strong>
        <span className="project-size">{session.doc.width} × {session.doc.height}</span>
        <span className="top-spacer" />
        <span className={localClass(localText)} title={localText}>{localText}</span>
        <span className={cloudClass(record.syncState)} title={backupLabel(record.syncState)}>{backupLabel(record.syncState)}</span>
        {localText === ru.saveError ? (
          <button type="button" onClick={() => retry(queue, payloadRef.current, id, setRecord)}>{ru.retry}</button>
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
      <nav className="tools" aria-label={ru.tools} inert={!toolsOpen}>
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
        <span className="tool-spacer" />
        <button type="button" className="icon-btn" aria-label={ru.collapseTools} title={ru.collapseTools} onClick={() => setToolsOpen(false)}>
          <Icon name="chevronLeft" />
        </button>
      </nav>
      <div className="stage">
        <CanvasView session={session} frame={frame} axisSnap={axisSnap} onChange={refresh} />
      </div>
      <button type="button" className="scrim" aria-label={ru.closePanel} onClick={() => setPanelOpen(false)} />
      <aside className="side" inert={!panelOpen}>
        {error ? <p className="warning">{error}</p> : null}
        <section className="group">
          <h2>{ru.display}</h2>
          <label className="check"><input type="checkbox" checked={session.doc.gridVisible} onChange={(event) => { session.doc.gridVisible = event.target.checked; saveView(); }} />{ru.grid}</label>
          <label className="check"><input type="checkbox" checked={session.doc.checkerVisible} onChange={(event) => { session.doc.checkerVisible = event.target.checked; saveView(); }} />{ru.checker}</label>
          <label>{ru.checkerBlock}
            <input type="number" min={1} max={32} value={session.doc.checkerBlock} onChange={(event) => { session.doc.checkerBlock = Number(event.target.value) || 1; saveView(); }} />
          </label>
        </section>
        <section className="group">
          <h2>{ru.symmetry}</h2>
          <div className="seg" role="group" aria-label={ru.symmetry}>
            {symmetryModes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                aria-pressed={session.doc.symmetry.mode === mode.id}
                onClick={() => { session.doc.symmetry = { ...session.doc.symmetry, mode: mode.id }; saveView(); }}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={session.doc.symmetry.showAxes} onChange={(event) => { session.doc.symmetry = { ...session.doc.symmetry, showAxes: event.target.checked }; saveView(); }} />
            {ru.showAxes}
          </label>
          <div className="nudge">
            <span>{ru.axisVertical}</span>
            <button type="button" className="icon-btn" aria-label={ru.nudgeLeft} title={ru.nudgeLeft} onClick={() => nudge(session, 'axisX2', -1, axisSnap, saveView)}><Icon name="chevronLeft" /></button>
            <button type="button" className="icon-btn" aria-label={ru.nudgeRight} title={ru.nudgeRight} onClick={() => nudge(session, 'axisX2', 1, axisSnap, saveView)}><Icon name="chevronRight" /></button>
            <span>{ru.axisHorizontal}</span>
            <button type="button" className="icon-btn" aria-label={ru.nudgeUp} title={ru.nudgeUp} onClick={() => nudge(session, 'axisY2', -1, axisSnap, saveView)}><Icon name="chevronUp" /></button>
            <button type="button" className="icon-btn" aria-label={ru.nudgeDown} title={ru.nudgeDown} onClick={() => nudge(session, 'axisY2', 1, axisSnap, saveView)}><Icon name="chevronDown" /></button>
          </div>
          <div className="seg">
            <button type="button" aria-pressed={axisSnap === 'edge'} onClick={() => chooseSnap('edge')}>{ru.snapEdge}</button>
            <button type="button" aria-pressed={axisSnap === 'center'} onClick={() => chooseSnap('center')}>{ru.snapCenter}</button>
          </div>
          <button type="button" onClick={() => centerAxes(session, axisSnap, saveView)}>{ru.centerAxes}</button>
          <p className="axis-coords">{axisLabel(session.doc.symmetry.axisX2, session.doc.width, true)}</p>
          <p className="axis-coords">{axisLabel(session.doc.symmetry.axisY2, session.doc.height, false)}</p>
        </section>
        <section className="group">
          <h2>{ru.selection}</h2>
          {session.selection ? <p className="note">{selectionSizeLabel(session.selection)}</p> : null}
          {session.notice ? <p className="note">{session.notice}</p> : null}
          {session.pasteClipped ? <p className="note">{ru.clipped}</p> : null}
          <div className="row">
            <button type="button" onClick={() => { session.copySelection(); refresh(); }}>{ru.copy}</button>
            <button type="button" onClick={() => { session.cutSelection(); refresh(); }}>{ru.cut}</button>
            <button type="button" onClick={() => { session.beginPaste(); refresh(); }}>{ru.paste}</button>
          </div>
          {session.pasteOrigin ? (
            <div className="row">
              <button type="button" className="icon-btn" aria-label={ru.nudgeLeft} onClick={() => { session.movePaste(-1, 0); refresh(); }}><Icon name="chevronLeft" /></button>
              <button type="button" className="icon-btn" aria-label={ru.nudgeRight} onClick={() => { session.movePaste(1, 0); refresh(); }}><Icon name="chevronRight" /></button>
              <button type="button" className="icon-btn" aria-label={ru.nudgeUp} onClick={() => { session.movePaste(0, -1); refresh(); }}><Icon name="chevronUp" /></button>
              <button type="button" className="icon-btn" aria-label={ru.nudgeDown} onClick={() => { session.movePaste(0, 1); refresh(); }}><Icon name="chevronDown" /></button>
              <button type="button" onClick={() => { session.confirmPaste(); refresh(); }}>{ru.pasteConfirm}</button>
              <button type="button" onClick={() => { session.cancelPaste(); refresh(); }}>{ru.cancel}</button>
            </div>
          ) : null}
          {session.pasteOrigin ? <p className="note">{ru.pasteHint}</p> : null}
        </section>
        <section className="group">
          <h2>{ru.palette}</h2>
          <div className="palette" aria-label={ru.palette}>
            {session.doc.palette.map((color, index) => (
              <button
                key={color.id}
                type="button"
                className="swatch"
                style={{ background: color.hex }}
                aria-label={color.name}
                title={`${color.name} ${color.hex}`}
                aria-pressed={session.colorSlot === slotOf(index)}
                onClick={() => { session.setColorSlot(slotOf(index)); setHex(color.hex); setColorName(color.name); refresh(); }}
              />
            ))}
          </div>
          <button type="button" aria-pressed={session.tool === 'picker'} onClick={() => { session.setTool('picker'); refresh(); }}>{ru.picker}</button>
          <label>{ru.colorName}<input value={colorName} onChange={(event) => setColorName(event.target.value)} /></label>
          <label>{ru.hex}
            <span className="hex-row">
              <input type="color" value={normalizeHex(hex) ?? '#9e2a2b'} aria-label={ru.hex} onChange={(event) => setHex(event.target.value)} />
              <input value={hex} spellCheck={false} onChange={(event) => setHex(event.target.value)} />
            </span>
          </label>
          <div className="row">
            <button type="button" onClick={() => add(session, colorName, hex, refresh)}>{ru.addColor}</button>
            <button type="button" onClick={() => edit(session, colorName, hex, refresh)}>{ru.editColor}</button>
          </div>
          {session.colorSlot > 0 && colorUsed(session.doc.cells, session.colorSlot) ? <p className="note">{ru.usedColor}</p> : null}
          <label>{ru.replaceWith}
            <select value={replaceSlot} onChange={(event) => setReplaceSlot(Number(event.target.value))}>
              <option value={0}>{ru.emptyColor}</option>
              {session.doc.palette.map((color, index) => (
                <option key={color.id} value={slotOf(index)}>{color.name}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => { if (session.deleteColor(session.colorSlot - 1, replaceSlot)) refresh(); }}>{ru.deleteColor}</button>
        </section>
        <section className="group">
          <h2>{ru.project}</h2>
          <ResizeForm session={session} onDone={refresh} />
          <div className="row">
            <button type="button" onClick={() => setPngOpen(true)}>{ru.exportPng}</button>
            <button type="button" onClick={() => download(new TextEncoder().encode(exportProjectFile(record.id, record.name, session.doc)), `${record.name}.json`, 'application/json')}>{ru.exportJson}</button>
          </div>
          <button type="button" onClick={() => void backupNow(record, session)}>{ru.backupRetry}</button>
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
      <p className="note">{ru.resize}</p>
      <label>{ru.width}<input type="number" min={1} max={4000} value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
      <label>{ru.height}<input type="number" min={1} max={4000} value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
      <button type="submit">{ru.applySize}</button>
    </form>
  );
}

function add(session: EditorSession, name: string, hex: string, refresh: () => void): void {
  const normalized = normalizeHex(hex);
  if (!normalized) return;
  const color: PaletteColor = { id: crypto.randomUUID(), name: name || 'Цвет', hex: normalized };
  session.setView({ palette: [...session.doc.palette, color] });
  session.setColorSlot(session.doc.palette.length);
  refresh();
}

function edit(session: EditorSession, name: string, hex: string, refresh: () => void): void {
  const normalized = normalizeHex(hex);
  if (!normalized || session.colorSlot < 1) return;
  const palette = session.doc.palette.map((color, index) => index === session.colorSlot - 1 ? { ...color, name: name || color.name, hex: normalized } : color);
  session.setView({ palette });
  refresh();
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
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const ownerId = await repository.readMeta<string>('backupUserId');
  const enabled = await repository.readMeta<boolean>('backupEnabled');
  if (!url || !anonKey || !ownerId || !enabled || session.gesture || !navigator.onLine) return;
  if (record.syncState === 'backed-up' && record.documentRevision === session.revision) return;
  await enqueueBackup(repository, { ...record, documentRevision: session.revision });
  const { createSupabaseTransport } = await import('../backup/supabase/adapter.ts');
  const transport = await createSupabaseTransport({ url, anonKey, ownerId });
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
