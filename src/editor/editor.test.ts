import { describe, expect, it } from 'vitest';
import { backingStoreSize, gestureViewport, resizeViewport, screenToCell, zoomAt } from './canvas/coords.ts';
import { createDocument, resizeDocument, sizeDecision } from './canvas/grid.ts';
import { emptyHistory } from './history/patches.ts';
import { mirrorColumn, mirrorRow } from './symmetry/reflect.ts';
import { pickRecentColor } from './palette/palette.ts';
import { EditorSession } from './session.ts';
import { floodIndices } from './tools/fill.ts';
import { bresenham } from './tools/stroke.ts';
import { circleCells, diamondCells, rectOutline } from './tools/shapes.ts';
import { normalizeSelection, resizeSelectionRect } from './selection/selection.ts';
import { CHECKPOINT_MS } from '../model/types.ts';

function session(width = 8, height = 8, now = () => 0): EditorSession {
  return new EditorSession(createDocument(width, height), emptyHistory(), 0, now);
}

describe('coordinates', () => {
  const viewport = { scale: 2, panX: 10, panY: 20, cellSize: 10 };
  const rect = { left: 5, top: 7, width: 200, height: 100 };

  it('maps edges and stays stable across device pixel ratio', () => {
    const origin = screenToCell(5 + 10, 7 + 20, rect, viewport, 1);
    const scaled = screenToCell(5 + 10, 7 + 20, rect, viewport, 3);
    expect(origin).toEqual({ x: 0, y: 0 });
    expect(scaled).toEqual(origin);
    const last = screenToCell(5 + 10 + 8 * 10 * 2 - 1, 7 + 20 + 8 * 10 * 2 - 1, rect, viewport, 2);
    expect(last).toEqual({ x: 7, y: 7 });
    expect(backingStoreSize(200, 100, 2)).toEqual({ width: 400, height: 200 });
  });

  it('zooms toward the pointer and keeps the center cell on resize', () => {
    const next = zoomAt(viewport, 30, 40, 4);
    const before = screenToCell(5 + 30, 7 + 40, rect, viewport, 1);
    const after = screenToCell(5 + 30, 7 + 40, rect, next, 1);
    expect(after).toEqual(before);
    const resized = resizeViewport(viewport, { width: 200, height: 100 }, { width: 100, height: 200 });
    const centerBefore = screenToCell(5 + 100, 7 + 50, rect, viewport, 1);
    const centerAfter = screenToCell(5 + 50, 7 + 100, { ...rect, width: 100, height: 200 }, resized, 1);
    expect(centerAfter).toEqual(centerBefore);
  });

  it('pans when two fingers move together and zooms when they spread', () => {
    const origin = { midX: 40, midY: 50, distance: 100 };
    const panned = gestureViewport(viewport, origin, 70, 80, 100);
    expect(panned.scale).toBe(viewport.scale);
    expect(panned.panX).toBeCloseTo(viewport.panX + 30);
    expect(panned.panY).toBeCloseTo(viewport.panY + 30);
    const zoomed = gestureViewport(viewport, origin, 40, 50, 200);
    const before = screenToCell(rect.left + 40, rect.top + 50, rect, viewport, 1);
    const after = screenToCell(rect.left + 40, rect.top + 50, rect, zoomed, 1);
    expect(zoomed.scale).toBe(4);
    expect(after).toEqual(before);
  });
});

describe('pencil, eraser, fill, picker', () => {
  it('draws a diagonal without holes and collapses repeats into one undo step', () => {
    const editor = session();
    editor.colorSlot = 1;
    editor.pointerDown({ x: 0, y: 0 });
    editor.pointerMove({ x: 5, y: 5 });
    editor.pointerMove({ x: 5, y: 5 });
    editor.pointerUp();
    const line = bresenham(0, 0, 5, 5);
    expect(line).toHaveLength(6);
    for (let i = 1; i < line.length; i++) {
      const prev = line[i - 1];
      const point = line[i];
      if (!prev || !point) continue;
      expect(Math.abs(point.x - prev.x) + Math.abs(point.y - prev.y)).toBeGreaterThan(0);
      expect(Math.abs(point.x - prev.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(point.y - prev.y)).toBeLessThanOrEqual(1);
      expect(editor.doc.cells[point.y * 8 + point.x]).toBe(1);
    }
    expect(editor.history.undo).toHaveLength(1);
    expect(editor.history.undo[0]?.patches).toHaveLength(6);
    editor.undo();
    expect(editor.doc.cells[0]).toBe(0);
    editor.redo();
    expect(editor.doc.cells[5 * 8 + 5]).toBe(1);
  });

  it('erases to empty without removing the grid', () => {
    const editor = session();
    editor.colorSlot = 1;
    editor.pointerDown({ x: 1, y: 1 });
    editor.pointerUp();
    editor.setTool('eraser');
    editor.pointerDown({ x: 1, y: 1 });
    editor.pointerUp();
    expect(editor.doc.cells[9]).toBe(0);
    expect(editor.doc.width).toBe(8);
  });

  it('paints a square of the chosen brush size', () => {
    const editor = session();
    editor.brushSize = 2;
    editor.pointerDown({ x: 1, y: 1 });
    editor.pointerUp();
    expect(editor.doc.cells[1 * 8 + 1]).toBe(1);
    expect(editor.doc.cells[1 * 8 + 2]).toBe(1);
    expect(editor.doc.cells[2 * 8 + 1]).toBe(1);
    expect(editor.doc.cells[2 * 8 + 2]).toBe(1);
    expect(editor.doc.cells[0]).toBe(0);
  });

  it('erases a square of the chosen size', () => {
    const editor = session();
    editor.doc.cells.fill(1);
    editor.setTool('eraser');
    editor.eraserSize = 2;
    editor.pointerDown({ x: 1, y: 1 });
    editor.pointerUp();
    expect(editor.doc.cells[1 * 8 + 1]).toBe(0);
    expect(editor.doc.cells[1 * 8 + 2]).toBe(0);
    expect(editor.doc.cells[2 * 8 + 1]).toBe(0);
    expect(editor.doc.cells[2 * 8 + 2]).toBe(0);
    expect(editor.doc.cells[0]).toBe(1);
  });

  it('flood-fills a 4-connected region as one undo step and ignores diagonals', () => {
    const editor = session(3, 3);
    editor.doc.cells[0] = 1;
    editor.doc.cells[4] = 1;
    const region = floodIndices(editor.doc.cells, 3, 3, 0, 0);
    expect(region).toEqual([0]);
    const broad = session(40, 40);
    broad.colorSlot = 2;
    broad.setTool('fill');
    broad.pointerDown({ x: 0, y: 0 });
    expect(broad.doc.cells.every((cell) => cell === 2)).toBe(true);
    expect(broad.history.undo).toHaveLength(1);
    broad.undo();
    expect(broad.doc.cells[0]).toBe(0);
    const wipe = session(3, 3);
    wipe.doc.cells[0] = 1;
    wipe.doc.cells[1] = 1;
    wipe.setTool('fill');
    wipe.fillErase = true;
    wipe.pointerDown({ x: 0, y: 0 });
    expect(wipe.doc.cells[0]).toBe(0);
    expect(wipe.doc.cells[1]).toBe(0);
    expect(wipe.doc.cells[3]).toBe(0);
    wipe.setTool('pencil');
    expect(wipe.fillErase).toBe(false);
    wipe.setTool('fill');
    expect(wipe.fillErase).toBe(false);
  });

  it('picks the color under the pointer', () => {
    const editor = session();
    editor.doc.cells[3] = 4;
    editor.setTool('picker');
    editor.pointerDown({ x: 3, y: 0 });
    expect(editor.colorSlot).toBe(4);
    editor.pointerDown({ x: 0, y: 0 });
    expect(editor.colorSlot).toBe(4);
  });

  it('checkpoints a long stroke on the timer without an undo entry yet', () => {
    let now = 0;
    const editor = session(8, 8, () => now);
    const saved: string[] = [];
    editor.onPersist = (payload) => saved.push(payload.type);
    editor.pointerDown({ x: 0, y: 0 });
    now = CHECKPOINT_MS;
    editor.pointerMove({ x: 4, y: 0 });
    expect(saved).toContain('checkpoint');
    expect(editor.history.undo).toHaveLength(0);
    expect(editor.doc.cells[4]).toBe(1);
    editor.pointerUp();
    expect(editor.history.undo).toHaveLength(1);
  });
});

describe('symmetry', () => {
  it('mirrors across a cell boundary, a cell center, both axes, and the edge', () => {
    expect(mirrorColumn(0, 4)).toBe(3);
    expect(mirrorColumn(1, 4)).toBe(2);
    expect(mirrorColumn(2, 5)).toBe(2);
    expect(mirrorColumn(0, 5)).toBe(4);
    expect(mirrorRow(0, 0)).toBe(-1);
    const editor = session(4, 4);
    editor.doc.symmetry = { mode: 'both', axisX2: 4, axisY2: 4, showAxes: false };
    editor.pointerDown({ x: 0, y: 0 });
    editor.pointerUp();
    expect(editor.doc.cells[0]).toBe(1);
    expect(editor.doc.cells[3]).toBe(1);
    expect(editor.doc.cells[3 * 4]).toBe(1);
    expect(editor.doc.cells[3 * 4 + 3]).toBe(1);
    expect(editor.history.undo[0]?.patches).toHaveLength(4);
  });

  it('fills each mirrored seed once', () => {
    const editor = session(4, 1);
    editor.doc.cells[0] = 1;
    editor.doc.cells[1] = 1;
    editor.doc.symmetry = { mode: 'vertical', axisX2: 4, axisY2: 2, showAxes: true };
    editor.colorSlot = 3;
    editor.setTool('fill');
    editor.pointerDown({ x: 0, y: 0 });
    expect([...editor.doc.cells]).toEqual([3, 3, 3, 3]);
    expect(editor.history.undo).toHaveLength(1);
  });
});

describe('shapes', () => {
  it('previews without writing and commits one undo step', () => {
    const editor = session();
    editor.setTool('line');
    editor.pointerDown({ x: 0, y: 1 });
    editor.pointerMove({ x: 5, y: 1 });
    expect(editor.doc.cells[1 * 8 + 5]).toBe(0);
    editor.pointerUp();
    expect(editor.doc.cells[1 * 8 + 5]).toBe(1);
    expect(editor.history.undo).toHaveLength(1);
    editor.cancelGesture();
    editor.setTool('rect');
    editor.pointerDown({ x: 0, y: 0 });
    editor.pointerMove({ x: 3, y: 2 });
    editor.cancelGesture();
    expect(editor.doc.cells[3]).toBe(0);
  });

  it('drops the selection when drawing starts and clears it on request', () => {
    const editor = session();
    editor.pointerDown({ x: 1, y: 1 });
    editor.pointerUp();
    editor.selection = { x: 1, y: 1, width: 1, height: 1 };
    editor.clearSelection();
    expect(editor.doc.cells[1 * 8 + 1]).toBe(0);
    expect(editor.selection).toEqual({ x: 1, y: 1, width: 1, height: 1 });
    editor.pointerDown({ x: 2, y: 2 });
    expect(editor.selection).toBeNull();
    editor.pointerUp();
  });

  it('paints a straight line at the chosen thickness and reports the rectangle size', () => {
    const editor = session();
    editor.setTool('line');
    editor.lineSize = 2;
    editor.pointerDown({ x: 1, y: 1 });
    editor.pointerMove({ x: 3, y: 1 });
    editor.pointerUp();
    expect(editor.doc.cells[1 * 8 + 1]).toBe(1);
    expect(editor.doc.cells[2 * 8 + 1]).toBe(1);
    expect(editor.doc.cells[1 * 8 + 4]).toBe(1);
    editor.setTool('rect');
    editor.pointerDown({ x: 0, y: 0 });
    editor.pointerMove({ x: 3, y: 1 });
    expect(editor.liveRectSize()).toEqual({ width: 4, height: 2 });
    editor.pointerUp();
  });

  it('covers degenerate circle, rectangle, and diamond', () => {
    expect(circleCells({ x: 2, y: 2 }, 0)).toEqual([{ x: 2, y: 2 }]);
    expect(circleCells({ x: 2, y: 2 }, 1).map((point) => `${point.x},${point.y}`).sort()).toEqual(
      ['1,2', '2,1', '2,3', '3,2'].sort(),
    );
    expect(rectOutline({ x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([{ x: 1, y: 1 }]);
    expect(diamondCells({ x: 3, y: 3 }, 0)).toEqual([{ x: 3, y: 3 }]);
    const editor = session();
    editor.doc.symmetry = { mode: 'vertical', axisX2: 8, axisY2: 8, showAxes: true };
    editor.setTool('circle');
    editor.pointerDown({ x: 1, y: 2 });
    editor.pointerUp();
    expect(editor.doc.cells[2 * 8 + 1]).toBe(1);
    expect(editor.doc.cells[2 * 8 + mirrorColumn(1, 8)]).toBe(1);
  });
});

describe('recent colors', () => {
  it('keeps an existing hex in place and appends a new one', () => {
    const palette = createDocument(2, 2).palette;
    expect(pickRecentColor(palette, [1], '#1a1614')).toMatchObject({ slot: 1, palette });
    const added = pickRecentColor(palette, [1], '#112233');
    expect(added?.slot).toBe(2);
    expect(added?.palette).toHaveLength(2);
    expect(added?.palette[0]).toBe(palette[0]);
  });

  it('keeps the last 8 colors by overwriting the oldest swatch', () => {
    let palette = createDocument(2, 2).palette;
    let order = [1];
    for (let i = 0; i < 7; i++) {
      const picked = pickRecentColor(palette, order, `#01010${i}`);
      expect(picked).not.toBeNull();
      palette = picked!.palette;
      order = picked!.order;
    }
    expect(palette).toHaveLength(8);
    const dropped = pickRecentColor(palette, order, '#abcdef');
    expect(dropped?.palette).toHaveLength(8);
    expect(dropped?.palette[0]?.hex).toBe('#abcdef');
    expect(dropped?.palette.some((color) => color.hex === '#1a1614')).toBe(false);
    expect(dropped?.slot).toBe(1);
    expect(dropped?.order[7]).toBe(1);
  });
});

describe('selection', () => {
  it('scales the stitches inside a selection when a side is dragged', () => {
    const editor = session(8, 4);
    editor.doc.cells[0] = 1;
    editor.doc.cells[1] = 2;
    editor.setTool('select');
    editor.selection = { x: 0, y: 0, width: 2, height: 1 };
    editor.startScale();
    editor.previewScale('e', { x: 3, y: 0 });
    editor.commitScale();
    expect([...editor.doc.cells.slice(0, 4)]).toEqual([1, 1, 2, 2]);
    expect(editor.selection).toEqual({ x: 0, y: 0, width: 4, height: 1 });
    editor.undo();
    expect([...editor.doc.cells.slice(0, 4)]).toEqual([1, 2, 0, 0]);
  });

  it('resizes a selection from an edge or a corner and stays on the canvas', () => {
    const origin = { x: 2, y: 2, width: 4, height: 3 };
    expect(resizeSelectionRect(origin, 'e', { x: 10, y: 2 }, 20, 20)).toEqual({ x: 2, y: 2, width: 9, height: 3 });
    expect(resizeSelectionRect(origin, 'nw', { x: 0, y: 0 }, 20, 20)).toEqual({ x: 0, y: 0, width: 6, height: 5 });
    expect(resizeSelectionRect(origin, 'w', { x: 8, y: 2 }, 20, 20)).toEqual({ x: 5, y: 2, width: 4, height: 3 });
    expect(resizeSelectionRect(origin, 's', { x: 2, y: 100 }, 20, 12)).toEqual({ x: 2, y: 2, width: 4, height: 10 });
  });

  it('counts inclusive cells, including 1×1 and a 10-wide run', () => {
    expect(normalizeSelection({ x: 4, y: 4 }, { x: 4, y: 4 })).toMatchObject({ width: 1, height: 1 });
    expect(normalizeSelection({ x: 10, y: 0 }, { x: 19, y: 3 })).toEqual({ x: 10, y: 0, width: 10, height: 4 });
  });

  it('cuts, undoes, pastes twice, and moves in one history step', () => {
    const editor = session(12, 6);
    editor.pointerDown({ x: 1, y: 1 });
    editor.pointerUp();
    editor.setTool('select');
    editor.pointerDown({ x: 1, y: 1 });
    editor.pointerUp();
    const before = editor.doc.cells[1 * 12 + 1];
    editor.copySelection();
    expect(editor.doc.cells[1 * 12 + 1]).toBe(before);
    editor.cutSelection();
    expect(editor.doc.cells[1 * 12 + 1]).toBe(0);
    editor.undo();
    expect(editor.doc.cells[1 * 12 + 1]).toBe(1);
    editor.redo();
    const clip = editor.clipboard?.cells[0];
    editor.beginPaste();
    editor.confirmPaste();
    editor.beginPaste();
    editor.movePaste(2, 0);
    editor.confirmPaste();
    expect(editor.clipboard?.cells[0]).toBe(clip);
    expect(editor.doc.cells[1 * 12 + 1]).toBe(1);
    expect(editor.doc.cells[1 * 12 + 3]).toBe(1);
    expect(editor.selection).toEqual({ x: 3, y: 1, width: 1, height: 1 });
  });

  it('maps colors by hex across palettes and clips past the edge', () => {
    const editor = session(4, 2);
    editor.doc.symmetry.mode = 'vertical';
    editor.clipboard = {
      schemaVersion: 1,
      width: 2,
      height: 1,
      cells: new Uint16Array([1, 1]),
      palette: [{ id: 'new', name: 'Новый', hex: '#112233' }],
    };
    editor.beginPaste();
    expect(editor.notice).toBe('Симметрия не применяется к вставке');
    editor.movePaste(3, 0);
    editor.confirmPaste();
    expect(editor.pasteClipped).toBe(true);
    expect(editor.doc.palette.filter((color) => color.hex === '#112233')).toHaveLength(1);
    const painted = [...editor.doc.cells].filter((cell) => cell !== 0);
    expect(painted.length).toBe(1);
  });
});

describe('document limits', () => {
  it('rejects bad sizes and reports cropping', () => {
    expect(sizeDecision(0, 10)).toBe('reject');
    expect(sizeDecision(100, 100)).toBe('ok');
    expect(sizeDecision(600, 10)).toBe('confirm');
    expect(sizeDecision(600, 10, 1)).toBe('reject');
    const doc = createDocument(4, 2);
    doc.cells[7] = 1;
    const resized = resizeDocument(doc, 3, 2);
    expect(resized?.cropped).toBe(true);
    expect(resized?.doc.cells[7]).toBeUndefined();
  });
});
