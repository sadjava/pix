import { CHECKPOINT_MS, type CellPatch, type ClipboardPayload, type HistoryEntry, type Point, type ProjectDocument, type ToolId } from '../model/types.ts';
import { cloneCells, getCell } from './canvas/grid.ts';
import { applyPatches, patchesForValues } from './tools/stroke.ts';
import { floodIndices } from './tools/fill.ts';
import { circleCells, diamondCells, lineCells, radiusOf, rectOutline } from './tools/shapes.ts';
import { reflectPoints } from './symmetry/reflect.ts';
import { emptyHistory, pushHistory, redoHistory, undoHistory, type HistoryStacks } from './history/patches.ts';
import {
  blitClipboard,
  clearRegion,
  extractRegion,
  moveRegion,
  normalizeSelection,
  resizeSelectionRect,
  scaleRegion,
  type SelectionHandle,
  type SelectionRect,
} from './selection/selection.ts';
import { colorUsed, pickRecentColor, removeColor, slotOf } from './palette/palette.ts';

export interface GesturePreview {
  points: Point[];
  clipped: boolean;
}

interface StrokeGesture {
  kind: 'stroke';
  tool: 'pencil' | 'eraser';
  last: Point;
  patches: Map<number, CellPatch>;
  sinceCheckpoint: CellPatch[];
  lastCheckpointAt: number;
}

interface ShapeGesture {
  kind: 'shape';
  tool: 'line' | 'circle' | 'rect' | 'diamond';
  anchor: Point;
  current: Point;
}

interface SelectGesture {
  kind: 'select';
  anchor: Point;
  current: Point;
}

interface MoveGesture {
  kind: 'move';
  last: Point;
  originRect: SelectionRect;
  dx: number;
  dy: number;
}

type Gesture = StrokeGesture | ShapeGesture | SelectGesture | MoveGesture;

export interface EditorPersistPayload {
  doc: ProjectDocument;
  history: HistoryStacks;
  patches: CellPatch[];
  opNumber: number;
  type: string;
  checkpoint: boolean;
}

export class EditorSession {
  doc: ProjectDocument;
  history: HistoryStacks;
  tool: ToolId = 'pencil';
  colorSlot = 1;
  /** Square stamp edge, in cells. ponytail: capped at 8; a circle stamp would replace the square. */
  brushSize = 1;
  eraserSize = 1;
  lineSize = 1;
  /** Second tap on fill. The flooded cells become empty. */
  fillErase = false;
  /** Slot numbers, newest last. Not stored in the document. */
  colorOrder: number[];
  selection: SelectionRect | null = null;
  clipboard: ClipboardPayload | null = null;
  pasteOrigin: Point | null = null;
  pasteClipped = false;
  revision: number;
  gesture: Gesture | null = null;
  notice: string | null = null;
  onPersist: ((payload: EditorPersistPayload) => void) | null = null;
  private now: () => number;

  constructor(doc: ProjectDocument, history: HistoryStacks = emptyHistory(), revision = 0, now = () => Date.now()) {
    this.doc = doc;
    this.history = history;
    this.revision = revision;
    this.now = now;
    this.colorOrder = doc.palette.map((_, index) => index + 1).slice(-8);
    const newest = this.colorOrder[this.colorOrder.length - 1];
    if (newest && !this.colorOrder.includes(this.colorSlot)) this.colorSlot = newest;
  }

  setTool(tool: ToolId): void {
    this.cancelGesture();
    if (tool !== this.tool) this.fillErase = false;
    this.tool = tool;
  }

  setColorSlot(slot: number): void {
    this.colorSlot = slot;
  }

  useColor(hex: string): void {
    const picked = pickRecentColor(this.doc.palette, this.colorOrder, hex);
    if (!picked) return;
    this.colorOrder = picked.order;
    this.colorSlot = picked.slot;
    if (picked.palette !== this.doc.palette) this.setView({ palette: picked.palette });
  }

  pointerDown(cell: Point | null): void {
    if (!cell) return;
    if (this.tool === 'pan') return;
    if (this.tool === 'picker') {
      const slot = getCell(this.doc, cell.x, cell.y);
      if (slot !== 0) this.colorSlot = slot;
      return;
    }
    if (this.tool !== 'select') this.selection = null;
    if (this.tool === 'fill') {
      this.fillAt(cell);
      return;
    }
    if (this.tool === 'pencil' || this.tool === 'eraser') {
      const patches = new Map<number, CellPatch>();
      this.gesture = {
        kind: 'stroke',
        tool: this.tool,
        last: cell,
        patches,
        sinceCheckpoint: [],
        lastCheckpointAt: this.now(),
      };
      this.extendStroke(cell);
      return;
    }
    if (this.tool === 'line' || this.tool === 'circle' || this.tool === 'rect' || this.tool === 'diamond') {
      this.gesture = { kind: 'shape', tool: this.tool, anchor: cell, current: cell };
      return;
    }
    if (this.tool === 'select') {
      if (this.selection && inside(this.selection, cell)) {
        this.gesture = { kind: 'move', last: cell, originRect: this.selection, dx: 0, dy: 0 };
      } else {
        this.selection = null;
        this.gesture = { kind: 'select', anchor: cell, current: cell };
      }
    }
  }

  pointerMove(cell: Point | null): void {
    if (!this.gesture || !cell) return;
    if (this.gesture.kind === 'stroke') {
      this.extendStroke(cell);
      if (this.now() - this.gesture.lastCheckpointAt >= CHECKPOINT_MS) this.checkpointStroke();
      return;
    }
    if (this.gesture.kind === 'shape') this.gesture.current = cell;
    if (this.gesture.kind === 'select') this.gesture.current = cell;
    if (this.gesture.kind === 'move') {
      this.gesture.dx += cell.x - this.gesture.last.x;
      this.gesture.dy += cell.y - this.gesture.last.y;
      this.gesture.last = cell;
    }
  }

  pointerUp(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    if (gesture.kind === 'stroke') {
      const patches = [...gesture.patches.values()];
      this.commit('stroke', patches, true);
      return;
    }
    if (gesture.kind === 'shape') {
      const points = this.shapePoints(gesture);
      this.paintPoints(points, this.colorSlot, gesture.tool);
      return;
    }
    if (gesture.kind === 'select') {
      this.selection = normalizeSelection(gesture.anchor, gesture.current);
      return;
    }
    if (gesture.kind === 'move' && (gesture.dx !== 0 || gesture.dy !== 0) && this.selection) {
      const moved = moveRegion(this.doc.cells, this.doc.width, this.doc.height, gesture.originRect, gesture.dx, gesture.dy);
      this.applyCommit('move', moved.patches);
      this.selection = moved.rect;
      if (moved.clipped) this.notice = 'Часть выходит за холст';
    }
  }

  cancelGesture(): void {
    this.cancelScale();
    if (!this.gesture) return;
    if (this.gesture.kind === 'stroke') {
      const patches = [...this.gesture.patches.values()];
      applyPatches(this.doc.cells, patches, 'back');
      this.gesture = null;
      if (patches.length > 0) {
        this.revision += 1;
        this.persist('cancel', patches, false);
      }
      return;
    }
    this.gesture = null;
  }

  flushOpenStroke(): void {
    if (this.gesture?.kind === 'stroke') this.checkpointStroke();
  }

  liveSelection(): SelectionRect | null {
    if (this.gesture?.kind === 'select') return normalizeSelection(this.gesture.anchor, this.gesture.current);
    return this.selection;
  }

  liveRectSize(): { width: number; height: number } | null {
    const gesture = this.gesture;
    if (!gesture || gesture.kind !== 'shape' || gesture.tool !== 'rect') return null;
    return {
      width: Math.abs(gesture.current.x - gesture.anchor.x) + 1,
      height: Math.abs(gesture.current.y - gesture.anchor.y) + 1,
    };
  }

  preview(): GesturePreview | null {
    if (!this.gesture) return null;
    if (this.gesture.kind === 'shape') {
      return { points: reflectPoints(this.shapePoints(this.gesture), this.doc.symmetry, this.doc.width, this.doc.height), clipped: false };
    }
    if (this.gesture.kind === 'select') {
      const rect = normalizeSelection(this.gesture.anchor, this.gesture.current);
      return { points: rectPoints(rect), clipped: false };
    }
    if (this.gesture.kind === 'move' && this.selection) {
      const rect = { ...this.selection, x: this.gesture.originRect.x + this.gesture.dx, y: this.gesture.originRect.y + this.gesture.dy };
      return { points: rectPoints(rect), clipped: false };
    }
    return null;
  }

  undo(): void {
    this.cancelGesture();
    const result = undoHistory(this.doc.cells, this.history);
    if (!result) return;
    this.doc = { ...this.doc, cells: result.cells };
    this.history = result.stacks;
    this.revision += 1;
    this.persist('undo', [], false);
  }

  redo(): void {
    this.cancelGesture();
    const result = redoHistory(this.doc.cells, this.history);
    if (!result) return;
    this.doc = { ...this.doc, cells: result.cells };
    this.history = result.stacks;
    this.revision += 1;
    this.persist('redo', [], false);
  }

  copySelection(): void {
    if (!this.selection) return;
    this.clipboard = extractRegion(this.doc.cells, this.doc.width, this.doc.height, this.selection, this.doc.palette);
  }

  cutSelection(): void {
    if (!this.selection) return;
    this.copySelection();
    const patches = clearRegion(this.doc.cells, this.doc.width, this.doc.height, this.selection);
    this.applyCommit('cut', patches);
  }

  startScale(): void {
    this.cancelScale();
    const rect = this.selection;
    if (!rect) return;
    const cells = new Uint16Array(rect.width * rect.height);
    for (let y = 0; y < rect.height; y += 1) {
      for (let x = 0; x < rect.width; x += 1) {
        const gx = rect.x + x;
        const gy = rect.y + y;
        cells[y * rect.width + x] = gx >= 0 && gy >= 0 && gx < this.doc.width && gy < this.doc.height
          ? (this.doc.cells[gy * this.doc.width + gx] ?? 0)
          : 0;
      }
    }
    this.scaleSource = { rect, cells, patches: [] };
  }

  previewScale(handle: SelectionHandle, cell: Point): void {
    const source = this.scaleSource;
    if (!source) return;
    applyPatches(this.doc.cells, source.patches, 'back');
    const dest = resizeSelectionRect(source.rect, handle, cell, this.doc.width, this.doc.height);
    const patches = scaleRegion(this.doc.cells, this.doc.width, this.doc.height, source.rect, source.cells, dest);
    applyPatches(this.doc.cells, patches, 'forward');
    source.patches = patches;
    this.selection = dest;
  }

  commitScale(): void {
    if (!this.scaleSource) return;
    const patches = this.scaleSource.patches;
    this.scaleSource = null;
    if (patches.length === 0) return;
    this.commit('scale', patches, true);
  }

  private scaleSource: { rect: SelectionRect; cells: Uint16Array; patches: CellPatch[] } | null = null;

  private cancelScale(): void {
    if (!this.scaleSource) return;
    applyPatches(this.doc.cells, this.scaleSource.patches, 'back');
    this.selection = this.scaleSource.rect;
    this.scaleSource = null;
  }

  clearSelection(): void {
    if (!this.selection) return;
    const patches = clearRegion(this.doc.cells, this.doc.width, this.doc.height, this.selection);
    this.applyCommit('clear', patches);
  }

  beginPaste(): void {
    if (!this.clipboard) return;
    this.pasteOrigin = this.selection ? { x: this.selection.x, y: this.selection.y } : { x: 0, y: 0 };
    this.pasteClipped = false;
    if (this.doc.symmetry.mode !== 'off') this.notice = 'Симметрия не применяется к вставке';
  }

  movePaste(dx: number, dy: number): void {
    if (!this.pasteOrigin) return;
    this.pasteOrigin = { x: this.pasteOrigin.x + dx, y: this.pasteOrigin.y + dy };
  }

  confirmPaste(): void {
    if (!this.clipboard || !this.pasteOrigin) return;
    const origin = this.pasteOrigin;
    const clip = this.clipboard;
    const result = blitClipboard(
      this.doc.cells,
      this.doc.width,
      this.doc.height,
      this.doc.palette,
      this.clipboard,
      this.pasteOrigin,
    );
    this.doc = { ...this.doc, palette: result.palette };
    this.pasteClipped = result.clipped;
    if (result.clipped) this.notice = 'Часть выходит за холст';
    this.applyCommit('paste', result.patches);
    this.pasteOrigin = null;
    const x0 = Math.max(0, Math.min(this.doc.width - 1, origin.x));
    const y0 = Math.max(0, Math.min(this.doc.height - 1, origin.y));
    const x1 = Math.max(x0, Math.min(this.doc.width - 1, origin.x + clip.width - 1));
    const y1 = Math.max(y0, Math.min(this.doc.height - 1, origin.y + clip.height - 1));
    this.selection = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }

  cancelPaste(): void {
    this.pasteOrigin = null;
    this.pasteClipped = false;
  }

  deleteColor(paletteIndex: number, replacementSlot: number): boolean {
    const slot = slotOf(paletteIndex);
    if (colorUsed(this.doc.cells, slot) && replacementSlot === slot) return false;
    const removed = removeColor(this.doc.palette, this.doc.cells, paletteIndex, colorUsed(this.doc.cells, slot) ? replacementSlot : 0);
    if (!removed) return false;
    const patches: CellPatch[] = [];
    for (let i = 0; i < this.doc.cells.length; i++) {
      const before = this.doc.cells[i] ?? 0;
      const after = removed.cells[i] ?? 0;
      if (before !== after) patches.push({ index: i, before, after });
    }
    this.doc = { ...this.doc, palette: removed.palette, cells: removed.cells };
    if (this.colorSlot === slot) this.colorSlot = replacementSlot || 1;
    else if (this.colorSlot > slot) this.colorSlot -= 1;
    this.commit('palette', patches, true);
    return true;
  }

  setView(patch: Partial<Pick<ProjectDocument, 'gridVisible' | 'checkerVisible' | 'checkerBlock' | 'symmetry' | 'viewport' | 'palette'>>): void {
    this.doc = { ...this.doc, ...patch };
    const content = 'palette' in patch || 'symmetry' in patch || 'gridVisible' in patch || 'checkerVisible' in patch || 'checkerBlock' in patch;
    if (!content) {
      this.persist('viewport', [], false);
      return;
    }
    this.revision += 1;
    this.persist('view', [], false);
  }

  replaceDocument(doc: ProjectDocument): void {
    this.cancelGesture();
    this.doc = doc;
    this.selection = null;
    this.colorOrder = doc.palette.map((_, index) => index + 1).slice(-8);
    this.revision += 1;
    this.persist('replace', [], false);
  }

  private stamp(cell: Point): Point[] {
    const size = this.gesture?.kind === 'stroke' && this.gesture.tool === 'eraser' ? this.eraserSize : this.brushSize;
    if (this.gesture?.kind !== 'stroke') return [cell];
    return square(cell, size);
  }

  private fillAt(seed: Point): void {
    const seeds = reflectPoints([seed], this.doc.symmetry, this.doc.width, this.doc.height);
    const indexes = new Set<number>();
    for (const point of seeds) {
      for (const index of floodIndices(this.doc.cells, this.doc.width, this.doc.height, point.x, point.y)) {
        indexes.add(index);
      }
    }
    const value = this.fillErase ? 0 : this.colorSlot;
    const patches: CellPatch[] = [];
    for (const index of indexes) {
      const before = this.doc.cells[index] ?? 0;
      if (before === value) continue;
      patches.push({ index, before, after: value });
    }
    this.applyCommit('fill', patches);
  }

  private extendStroke(cell: Point): void {
    if (!this.gesture || this.gesture.kind !== 'stroke') return;
    const segment = lineCells(this.gesture.last, cell).flatMap((point) => this.stamp(point));
    const value = this.gesture.tool === 'eraser' ? 0 : this.colorSlot;
    const reflected = reflectPoints(segment, this.doc.symmetry, this.doc.width, this.doc.height);
    const patches = patchesForValues(this.doc.cells, this.doc.width, this.doc.height, reflected, () => value);
    applyPatches(this.doc.cells, patches, 'forward');
    for (const patch of patches) {
      const existing = this.gesture.patches.get(patch.index);
      if (existing) this.gesture.patches.set(patch.index, { ...existing, after: patch.after });
      else this.gesture.patches.set(patch.index, patch);
      this.gesture.sinceCheckpoint.push(patch);
    }
    this.gesture.last = cell;
  }

  private checkpointStroke(): void {
    if (!this.gesture || this.gesture.kind !== 'stroke') return;
    const patches = this.gesture.sinceCheckpoint;
    this.gesture.sinceCheckpoint = [];
    this.gesture.lastCheckpointAt = this.now();
    if (patches.length === 0) return;
    this.revision += 1;
    this.persist('checkpoint', patches, true);
  }

  private shapePoints(gesture: ShapeGesture): Point[] {
    if (gesture.tool === 'line') return lineCells(gesture.anchor, gesture.current).flatMap((point) => square(point, this.lineSize));
    if (gesture.tool === 'circle') return circleCells(gesture.anchor, radiusOf(gesture.anchor, gesture.current));
    if (gesture.tool === 'rect') return rectOutline(gesture.anchor, gesture.current);
    return diamondCells(gesture.anchor, radiusOf(gesture.anchor, gesture.current));
  }

  private paintPoints(points: Point[], value: number, type: string): void {
    const reflected = reflectPoints(points, this.doc.symmetry, this.doc.width, this.doc.height);
    const patches = patchesForValues(this.doc.cells, this.doc.width, this.doc.height, reflected, () => value);
    this.applyCommit(type, patches);
  }

  private applyCommit(type: string, patches: CellPatch[]): void {
    applyPatches(this.doc.cells, patches, 'forward');
    this.commit(type, patches, true);
  }

  private commit(type: string, patches: CellPatch[], alreadyApplied: boolean): void {
    if (!alreadyApplied) applyPatches(this.doc.cells, patches, 'forward');
    if (patches.length === 0 && type !== 'replace') {
      this.persist(type, patches, false);
      return;
    }
    this.revision += 1;
    if (patches.length > 0) {
      const entry: HistoryEntry = { opNumber: this.revision, type, patches };
      this.history = pushHistory(this.history, entry);
    }
    this.persist(type, patches, false);
  }

  private persist(type: string, patches: CellPatch[], checkpoint: boolean): void {
    this.onPersist?.({
      doc: { ...this.doc, cells: cloneCells(this.doc.cells) },
      history: this.history,
      patches,
      opNumber: this.revision,
      type,
      checkpoint,
    });
  }
}

function square(cell: Point, size: number): Point[] {
  if (size <= 1) return [cell];
  const half = Math.floor((size - 1) / 2);
  const points: Point[] = [];
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) points.push({ x: cell.x - half + dx, y: cell.y - half + dy });
  }
  return points;
}

function inside(rect: SelectionRect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

function rectPoints(rect: SelectionRect): Point[] {
  return rectOutline(
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width - 1, y: rect.y + rect.height - 1 },
  );
}

export function selectionSizeLabel(rect: { width: number; height: number }): string {
  return `${rect.width} × ${rect.height}`;
}
