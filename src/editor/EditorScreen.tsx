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
import { ru } from '../i18n/ru.ts';
import { randomId } from '../export/checksum.ts';
import { pngBytes } from '../export/png.ts';
import { exportProjectFile } from '../export/json.ts';
import { enqueueBackup, drainOutbox } from '../backup/outbox.ts';
import { snapAxis } from './canvas/coords.ts';
import { axisLabel } from './symmetry/axisLabel.ts';
import { Icon, type IconName } from './icons.tsx';
import { fitFrame, type TraceSprite } from './trace/trace.ts';
import type { TraceRow } from '../data/db.ts';

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
  { id: 'trace', label: ru.trace, icon: 'image' },
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
  const [sizeFor, setSizeFor] = useState<{ tool: 'pencil' | 'eraser' | 'line'; top: number } | null>(null);
  const [fillPop, setFillPop] = useState<number | null>(null);
  const [tracePop, setTracePop] = useState<number | null>(null);
  const traceTimer = useRef(0);
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
      void repository.listTraces(id).then(async (rows) => {
        const sprites: TraceSprite[] = [];
        for (const row of rows) {
          if (cancel) break;
          try {
            const image = await createImageBitmap(row.blob);
            sprites.push(spriteFromRow(row, image));
          } catch {
            // A picture this browser cannot decode stays out of the way.
          }
        }
        if (cancel) {
          for (const sprite of sprites) closeImage(sprite.image);
          return;
        }
        editor.traces = sprites;
        refresh();
        if (sprites.length === 0 || cancel) return;
        const stampKey = `traceRevision:${id}`;
        const stamp = await repository.readMeta<number>(stampKey);
        if (cancel || stamp === editor.revision) return;
        const published = await repository.publishTraces(id);
        if (cancel || !published) return;
        editor.revision = Math.max(editor.revision, published.documentRevision);
        setRecord(published);
        const enabled = await repository.readMeta<boolean>('backupEnabled');
        const next = enabled ? await backupNow(published, editor) : null;
        if (!enabled || next?.syncState === 'backed-up' || published.syncState === 'local-only') {
          await repository.writeMeta(stampKey, editor.revision);
        }
        if (next) setRecord(next);
        refresh();
      });
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const editor = sessionRef.current;
      if (!editor || editor.tool !== 'trace' || !editor.activeTraceId) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      void forgetTrace(editor, editor.activeTraceId).then(async () => {
        const published = await repository.publishTraces(id);
        if (published) {
          editor.revision = Math.max(editor.revision, published.documentRevision);
          setRecord(published);
          const next = await backupNow(published, editor);
          if (next) setRecord(next);
        }
        refresh();
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  useEffect(() => {
    const editor = sessionRef.current;
    if (!editor || !record) return;
    const timer = window.setTimeout(() => {
      void backupNow(record, editor).then(applyBackup);
    }, 15_000);
    const onLine = () => {
      void backupNow(record, editor).then(applyBackup);
    };
    window.addEventListener('online', onLine);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('online', onLine);
    };
  }, [record]);

  const applyBackup = (next: ProjectRecord | null) => {
    if (!next) return;
    setRecord(next);
    refresh();
  };

  const publishPictures = async () => {
    const editor = sessionRef.current;
    if (!editor) return;
    const published = await repository.publishTraces(id);
    if (!published) return;
    editor.revision = Math.max(editor.revision, published.documentRevision);
    setRecord(published);
    const next = await backupNow(published, editor);
    if (next?.syncState === 'backed-up' || published.syncState === 'local-only') {
      await repository.writeMeta(`traceRevision:${id}`, editor.revision);
    }
    applyBackup(next);
  };

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
  const rectSize = session.liveRectSize();
  const live = session.liveSelection();
  const activeTrace = session.traces.find((trace) => trace.id === session.activeTraceId) ?? null;

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
            onClick={(event) => {
              if (tool.id === 'fill' && session.tool === 'fill') {
                const box = event.currentTarget.getBoundingClientRect();
                setFillPop((current) => current === null ? box.top + box.height / 2 : null);
                setSizeFor(null);
                setTracePop(null);
                return;
              }
              if (tool.id === 'trace') {
                const box = event.currentTarget.getBoundingClientRect();
                const top = box.top + box.height / 2;
                if (session.tool === 'trace') {
                  setTracePop((current) => current === null ? top : null);
                  return;
                }
                session.setTool('trace');
                setSizeFor(null);
                setFillPop(null);
                setTracePop(session.traces.length === 0 ? top : null);
                refresh();
                return;
              }
              const sized = tool.id === 'pencil' || tool.id === 'eraser' || tool.id === 'line' ? tool.id : null;
              if (sized && session.tool === sized) {
                const box = event.currentTarget.getBoundingClientRect();
                const top = box.top + box.height / 2;
                setSizeFor((current) => current?.tool === sized ? null : { tool: sized, top });
                setTracePop(null);
                return;
              }
              session.setTool(tool.id);
              setSizeFor(null);
              setFillPop(null);
              setTracePop(null);
              refresh();
            }}
          >
            <Icon name={tool.icon} />
          </button>
        ))}
      </nav>
      {sizeFor ? (
        <label className="size-pop" style={{ top: sizeFor.top }}>
          <input
            type="range"
            min={1}
            max={8}
            aria-label={sizeFor.tool === 'eraser' ? ru.eraserSize : sizeFor.tool === 'line' ? ru.lineSize : ru.brushSize}
            value={toolSize(session, sizeFor.tool)}
            onChange={(event) => {
              const size = Number(event.target.value);
              if (sizeFor.tool === 'eraser') session.eraserSize = size;
              else if (sizeFor.tool === 'line') session.lineSize = size;
              else session.brushSize = size;
              refresh();
            }}
          />
          <span>{toolSize(session, sizeFor.tool)}</span>
        </label>
      ) : null}
      {fillPop !== null ? (
        <button
          type="button"
          className="size-pop icon-btn"
          style={{ top: fillPop }}
          aria-pressed={session.fillErase}
          aria-label={ru.fillErase}
          title={ru.fillErase}
          onClick={() => { session.fillErase = !session.fillErase; refresh(); }}
        >
          <Icon name="trash" />
        </button>
      ) : null}
      {tracePop !== null ? (
        <div className="size-pop trace-pop" style={{ top: tracePop }}>
          <label className="trace-add">
            {ru.traceAdd}
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                // Chrome drops a live FileList when the input is cleared. Firefox keeps it.
                const files = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = '';
                if (files.length > 0) {
                  void addTraces(session, id, files, refresh, setError).then((added) => {
                    if (added > 0) return publishPictures();
                    return undefined;
                  });
                }
              }}
            />
          </label>
          {activeTrace ? (
            <>
              <input
                type="range"
                min={5}
                max={100}
                aria-label={ru.traceOpacity}
                value={Math.round(activeTrace.opacity * 100)}
                onChange={(event) => {
                  activeTrace.opacity = Number(event.target.value) / 100;
                  refresh();
                  window.clearTimeout(traceTimer.current);
                  const picture = activeTrace;
                  traceTimer.current = window.setTimeout(() => {
                    void repository.putTrace(traceRow(id, picture)).then(() => publishPictures());
                  }, 200);
                }}
              />
              <button type="button" className="icon-btn" aria-label={ru.traceDelete} title={ru.traceDelete} onClick={() => void forgetTrace(session, activeTrace.id).then(() => publishPictures())}>
                <Icon name="trash" />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="stage">
        <CanvasView session={session} frame={frame} axisSnap={axisSnap} axisLocked={axisLocked} onChange={refresh} onTrace={(sprite) => void repository.putTrace(traceRow(id, sprite)).then(() => publishPictures())} />
      </div>
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
            <button type="button" className="icon-btn" aria-label={ru.snapEdge} title={ru.snapEdge} aria-pressed={axisSnap === 'edge'} disabled={axisLocked} onClick={() => chooseSnap('edge')}><Icon name="snapEdge" /></button>
            <button type="button" className="icon-btn" aria-label={ru.snapCenter} title={ru.snapCenter} aria-pressed={axisSnap === 'center'} disabled={axisLocked} onClick={() => chooseSnap('center')}><Icon name="snapCenter" /></button>
            <button type="button" className="icon-btn" aria-label={ru.centerAxes} title={ru.centerAxes} aria-pressed={axesCentered(session, axisSnap)} disabled={axisLocked} onClick={() => centerAxes(session, axisSnap, saveView)}><Icon name="crosshair" /></button>
          </div>
          <p className="axis-coords" title={`${axisLabel(session.doc.symmetry.axisX2, session.doc.width, true)}. ${axisLabel(session.doc.symmetry.axisY2, session.doc.height, false)}`}>
            {shortAxis(session.doc.symmetry.axisX2, session.doc.width)} · {shortAxis(session.doc.symmetry.axisY2, session.doc.height)}
          </p>
        </section>
        <section className="group" aria-label={ru.selection}>
          {rectSize ? <p className="note">{selectionSizeLabel(rectSize)}</p> : live ? <p className="note">{selectionSizeLabel(live)}</p> : null}
          {session.notice ? <p className="note">{session.notice}</p> : null}
          {session.pasteClipped ? <p className="note">{ru.clipped}</p> : null}
          <div className="icon-row">
            <button type="button" className="icon-btn" aria-label={ru.copy} title={ru.copy} disabled={!session.selection} onClick={() => { session.copySelection(); refresh(); }}><Icon name="copy" /></button>
            <button type="button" className="icon-btn" aria-label={ru.paste} title={ru.paste} disabled={!session.clipboard} onClick={() => { session.beginPaste(); refresh(); }}><Icon name="paste" /></button>
            <button type="button" className="icon-btn" aria-label={ru.clearSelection} title={ru.clearSelection} disabled={!session.selection} onClick={() => { session.clearSelection(); refresh(); }}><Icon name="trash" /></button>
          </div>
        </section>
        <section className="group" aria-label={ru.project}>
          <ResizeForm session={session} onDone={refresh} />
          <div className="icon-row">
            <button type="button" className="icon-btn" aria-label={ru.exportPng} title={ru.exportPng} onClick={() => setPngOpen(true)}><Icon name="image" /></button>
            <button type="button" className="icon-btn" aria-label={ru.exportJson} title={ru.exportJson} onClick={() => download(new TextEncoder().encode(exportProjectFile(record.id, record.name, session.doc)), `${record.name}.json`, 'application/json')}><Icon name="file" /></button>
            <button type="button" className="icon-btn" aria-label={ru.backupRetry} title={ru.backupRetry} onClick={() => void backupNow(record, session).then(applyBackup)}><Icon name="cloud" /></button>
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
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(session.doc.width);
  const [height, setHeight] = useState(session.doc.height);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setWidth(session.doc.width);
          setHeight(session.doc.height);
          setOpen(true);
        }}
      >
        {ru.applySize}
      </button>
    );
  }
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
        setOpen(false);
        onDone();
      }}
    >
      <div className="icon-row">
        <input className="mini" type="number" min={1} max={4000} aria-label={ru.width} title={ru.width} value={width} onChange={(event) => setWidth(Number(event.target.value))} />
        <input className="mini" type="number" min={1} max={4000} aria-label={ru.height} title={ru.height} value={height} onChange={(event) => setHeight(Number(event.target.value))} />
        <button type="submit" className="icon-btn" aria-label={ru.confirm} title={ru.confirm}><Icon name="check" /></button>
      </div>
    </form>
  );
}

function toolSize(session: EditorSession, tool: 'pencil' | 'eraser' | 'line'): number {
  if (tool === 'eraser') return session.eraserSize;
  if (tool === 'line') return session.lineSize;
  return session.brushSize;
}

function axesCentered(session: EditorSession, mode: 'center' | 'edge'): boolean {
  const { symmetry, width, height } = session.doc;
  const x = clampAxis(snapAxis(width, mode), width);
  const y = clampAxis(snapAxis(height, mode), height);
  const vertical = symmetry.mode === 'vertical' || symmetry.mode === 'both';
  const horizontal = symmetry.mode === 'horizontal' || symmetry.mode === 'both';
  if (!vertical && !horizontal) return symmetry.axisX2 === x && symmetry.axisY2 === y;
  return (!vertical || symmetry.axisX2 === x) && (!horizontal || symmetry.axisY2 === y);
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

async function backupNow(record: ProjectRecord, session: EditorSession): Promise<ProjectRecord | null> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const ownerId = await repository.readMeta<string>('backupUserId');
  const enabled = await repository.readMeta<boolean>('backupEnabled');
  if (!url || !publishableKey || !ownerId || !enabled || session.gesture || !navigator.onLine) return null;
  await enqueueBackup(repository, { ...record, documentRevision: session.revision });
  const { createSupabaseTransport } = await import('../backup/supabase/adapter.ts');
  const transport = await createSupabaseTransport({ url, publishableKey, ownerId });
  await drainOutbox(repository, transport, ownerId, new Date().toISOString());
  const loaded = await repository.load(record.id);
  if ('doc' in loaded && loaded.record.documentRevision > session.revision && !session.gesture) {
    session.selection = null;
    session.pasteOrigin = null;
    session.doc = loaded.doc;
    session.history = loaded.history;
    session.revision = loaded.record.documentRevision;
  }
  const adopted = await adoptTraces(session, record.id);
  const fresh = await repository.db.projects.get(record.id);
  if (!fresh) return null;
  if (adopted || fresh.documentRevision !== record.documentRevision || fresh.syncState !== record.syncState) return fresh;
  return null;
}

async function adoptTraces(session: EditorSession, projectId: string): Promise<boolean> {
  const rows = await repository.listTraces(projectId);
  const same = rows.length === session.traces.length && rows.every((row) => session.traces.some((sprite) => sprite.id === row.id));
  if (same) return false;
  for (const sprite of session.traces) closeImage(sprite.image);
  const sprites: TraceSprite[] = [];
  for (const row of rows) {
    try {
      sprites.push(spriteFromRow(row, await createImageBitmap(row.blob)));
    } catch {
      // A picture this browser cannot decode stays out of the way.
    }
  }
  session.traces = sprites;
  if (!sprites.some((sprite) => sprite.id === session.activeTraceId)) session.activeTraceId = null;
  return true;
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

const TRACE_EDGE = 1600;

function spriteFromRow(row: TraceRow, image: ImageBitmap): TraceSprite {
  return {
    id: row.id,
    image,
    blob: row.blob,
    naturalWidth: image.width,
    naturalHeight: image.height,
    frame: { x: row.x, y: row.y, width: row.width, height: row.height, rotation: row.rotation },
    crop: { x: row.cropX, y: row.cropY, width: row.cropW, height: row.cropH },
    opacity: row.opacity,
  };
}

function traceRow(projectId: string, sprite: TraceSprite): TraceRow {
  return {
    id: sprite.id,
    projectId,
    blob: sprite.blob,
    x: sprite.frame.x,
    y: sprite.frame.y,
    width: sprite.frame.width,
    height: sprite.frame.height,
    rotation: sprite.frame.rotation,
    opacity: sprite.opacity,
    cropX: sprite.crop.x,
    cropY: sprite.crop.y,
    cropW: sprite.crop.width,
    cropH: sprite.crop.height,
  };
}

async function forgetTrace(session: EditorSession, traceId: string): Promise<void> {
  const index = session.traces.findIndex((trace) => trace.id === traceId);
  if (index < 0) return;
  const [sprite] = session.traces.splice(index, 1);
  if (session.activeTraceId === traceId) session.activeTraceId = null;
  closeImage(sprite?.image ?? null);
  await repository.deleteTrace(traceId);
}

async function addTraces(
  session: EditorSession,
  projectId: string,
  files: readonly File[],
  done: () => void,
  fail: (text: string) => void,
): Promise<number> {
  let added = 0;
  for (const file of files) {
    if (file.type && !file.type.startsWith('image/') && file.type !== 'application/octet-stream') continue;
    try {
      const prepared = await traceBitmap(file);
      const frame = fitFrame(session.doc.width, session.doc.height, prepared.image.width, prepared.image.height);
      frame.x += added * 6;
      frame.y += added * 6;
      const sprite: TraceSprite = {
        id: randomId(),
        image: prepared.image,
        blob: prepared.blob,
        naturalWidth: prepared.image.width,
        naturalHeight: prepared.image.height,
        frame,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        opacity: 0.8,
      };
      session.traces.push(sprite);
      session.activeTraceId = sprite.id;
      await repository.putTrace(traceRow(projectId, sprite));
      added += 1;
    } catch {
      fail(ru.traceFailed);
    }
  }
  if (added > 0) session.setTool('trace');
  done();
  return added;
}

async function traceBitmap(file: Blob): Promise<{ blob: Blob; image: ImageBitmap }> {
  const source = await decodeTrace(file);
  const edge = Math.max(source.width, source.height);
  // ponytail: long edge capped at 1600px so a phone photo does not exhaust the tablet.
  if (edge < TRACE_EDGE && file.size > 0 && file.size < 1_500_000) return { blob: file, image: source };
  const scale = Math.min(1, TRACE_EDGE / edge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    source.close();
    throw new Error('canvas');
  }
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('blob');
  return { blob, image: await createImageBitmap(blob) };
}

async function decodeTrace(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { resizeWidth: TRACE_EDGE, resizeQuality: 'medium' });
  } catch {
    try {
      return await createImageBitmap(file);
    } catch {
      return bitmapFromImage(file);
    }
  }
}

function bitmapFromImage(file: Blob): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      createImageBitmap(image).then(resolve, reject);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image'));
    };
    image.src = url;
  });
}

function closeImage(image: CanvasImageSource | null): void {
  if (image && 'close' in image && typeof image.close === 'function') image.close();
}

function deviceMemory(): number | undefined {
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === 'number' ? value : undefined;
}
