import { describe, expect, it } from 'vitest';
import { backingStoreSize, containViewport, gestureViewport, resizeViewport, screenToCell, zoomAt } from './canvas/coords.ts';
import { createDocument, resizeDocument, sizeDecision } from './canvas/grid.ts';
import { emptyHistory } from './history/patches.ts';
import { mirrorColumn, mirrorRow } from './symmetry/reflect.ts';
import { pickRecentColor } from './palette/palette.ts';
import { EditorSession, penButtonHover, stylusErasing } from './session.ts';
import { floodIndices } from './tools/fill.ts';
import { bresenham } from './tools/stroke.ts';
import { circleCells, diamondCells, rectOutline } from './tools/shapes.ts';
import { fillLasso, getSelectionCellSet, normalizeSelection, resizeSelectionRect, rotateRegion, snapRotation } from './selection/selection.ts';
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

  it('fits the rug again when a saved pan leaves the view', () => {
    const lost = { scale: 12, panX: 31_491, panY: 1_088_214_204, cellSize: 16 };
    const next = containViewport(lost, 800, 600, 100, 100);
    const drawH = 100 * 16 * next.scale;
    expect(next.panY + drawH).toBeGreaterThan(0);
    expect(next.panY).toBeLessThan(600);
    const kept = containViewport({ scale: 1, panX: -10, panY: 20, cellSize: 16 }, 400, 300, 8, 8);
    expect(kept.panX).toBe(-10);
    expect(kept.panY).toBe(20);
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

  it('erases only while the stylus button is held', () => {
    const editor = session();
    editor.doc.cells[0] = 1;
    editor.tool = 'pencil';
    editor.setPenErase(true);
    editor.pointerDown({ x: 0, y: 0 });
    editor.pointerMove({ x: 1, y: 0 });
    editor.setPenErase(false);
    editor.pointerMove({ x: 2, y: 0 });
    editor.pointerUp();
    expect(editor.doc.cells[0]).toBe(0);
    expect(editor.doc.cells[1]).toBe(0);
    expect(editor.doc.cells[2]).toBe(1);
    expect(editor.tool).toBe('pencil');
    expect(editor.history.undo).toHaveLength(1);
    expect(stylusErasing('pen', -1, 1)).toBe(false);
    expect(stylusErasing('pen', 2, 2)).toBe(true);
    expect(stylusErasing('pen', 5, 32)).toBe(true);
    expect(stylusErasing('pen', -1, 1 | 4)).toBe(true);
    expect(stylusErasing('pen', 1, 0)).toBe(true);
    expect(stylusErasing('mouse', 2, 2)).toBe(true);
    expect(stylusErasing('mouse', 1, 4)).toBe(false);
    expect(stylusErasing('touch', 5, 32)).toBe(false);
    expect(stylusErasing('eraser', 0, 1)).toBe(true);
    expect(penButtonHover('pen', 0, 1, 0)).toBe(true);
    expect(penButtonHover('pen', -1, 1, 0)).toBe(true);
    expect(penButtonHover('pen', 1, 4, 0)).toBe(true);
    expect(penButtonHover('pen', 1, 0, 0)).toBe(false);
    expect(penButtonHover('pen', 0, 0, 0)).toBe(false);
    expect(penButtonHover('pen', -1, 0, 0)).toBe(false);
    expect(penButtonHover('pen', 0, 1, 0.4)).toBe(false);
    expect(penButtonHover('mouse', 0, 1, 0)).toBe(false);
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

  it('undoes a fill that covers thousands of cells', () => {
    const editor = session(80, 80);
    editor.setTool('fill');
    editor.pointerDown({ x: 0, y: 0 });
    expect(editor.doc.cells[0]).toBe(1);
    expect(editor.doc.cells[80 * 80 - 1]).toBe(1);
    expect(editor.history.undo[0]?.packed?.index.length).toBe(80 * 80);
    editor.undo();
    expect(editor.doc.cells[0]).toBe(0);
    expect(editor.doc.cells[80 * 80 - 1]).toBe(0);
    editor.redo();
    expect(editor.doc.cells[10]).toBe(1);
  });

  it('preserves history and undoes a huge fill even after subsequent strokes', () => {
    const editor = session(500, 500);

    // 1. Draw 3 initial strokes
    editor.setTool('pencil');
    editor.setColorSlot(2);
    for (let i = 0; i < 3; i++) {
      editor.pointerDown({ x: i, y: 0 });
      editor.pointerUp();
    }
    expect(editor.history.undo).toHaveLength(3);
    expect(editor.doc.cells[0]).toBe(2);
    expect(editor.doc.cells[1]).toBe(2);
    expect(editor.doc.cells[2]).toBe(2);

    // 2. Accidental huge fill on the background (250,000 cells minus 3 cells)
    editor.setColorSlot(1);
    editor.setTool('fill');
    editor.pointerDown({ x: 10, y: 10 });
    expect(editor.history.undo).toHaveLength(4);
    expect(editor.doc.cells[10]).toBe(1);
    expect(editor.doc.cells[500 * 500 - 1]).toBe(1);

    // 3. User accidentally taps/draws another stroke after the fill
    editor.setTool('pencil');
    editor.setColorSlot(2);
    editor.pointerDown({ x: 100, y: 100 });
    editor.pointerUp();
    expect(editor.history.undo).toHaveLength(5);
    expect(editor.doc.cells[100 * 500 + 100]).toBe(2);

    // 4. Undo the accidental tap
    editor.undo();
    expect(editor.history.undo).toHaveLength(4);
    expect(editor.doc.cells[100 * 500 + 100]).toBe(1);

    // 5. Undo the accidental huge fill
    editor.undo();
    expect(editor.history.undo).toHaveLength(3);
    expect(editor.doc.cells[10]).toBe(0);
    expect(editor.doc.cells[500 * 500 - 1]).toBe(0);
    expect(editor.doc.cells[0]).toBe(2);
    expect(editor.doc.cells[1]).toBe(2);
    expect(editor.doc.cells[2]).toBe(2);

    // 6. User can continue undoing initial strokes
    editor.undo();
    expect(editor.doc.cells[2]).toBe(0);
    expect(editor.doc.cells[1]).toBe(2);
    editor.undo();
    expect(editor.doc.cells[1]).toBe(0);
    expect(editor.doc.cells[0]).toBe(2);
    editor.undo();
    expect(editor.doc.cells[0]).toBe(0);
    expect(editor.history.undo).toHaveLength(0);
  });

  it('keeps the previous color and swaps back to it', () => {
    const editor = session();
    editor.setColorSlot(1);
    editor.previousSlot = null;
    editor.doc.palette.push({ id: 'clay', name: 'Глина', hex: '#be6437' });
    editor.setTool('eraser');
    editor.setColorSlot(2);
    expect(editor.colorSlot).toBe(2);
    expect(editor.previousSlot).toBe(1);
    expect(editor.tool).toBe('pencil');
    editor.setTool('fill');
    editor.swapColors();
    expect(editor.colorSlot).toBe(1);
    expect(editor.previousSlot).toBe(2);
    expect(editor.tool).toBe('pencil');
  });

  it('picks the color under the pointer', () => {
    const editor = session();
    editor.doc.cells[3] = 4;
    editor.setTool('picker');
    editor.pointerDown({ x: 3, y: 0 });
    expect(editor.colorSlot).toBe(4);
    expect(editor.tool).toBe('pencil');
    editor.setTool('picker');
    editor.pointerDown({ x: 0, y: 0 });
    expect(editor.colorSlot).toBe(4);
    expect(editor.tool).toBe('picker');
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
    expect(pickRecentColor(palette, [1], '#000000')).toMatchObject({ slot: 1, palette });
    const added = pickRecentColor(palette, [1], '#112233');
    expect(added?.slot).toBe(2);
    expect(added?.palette).toHaveLength(2);
    expect(added?.palette[0]).toBe(palette[0]);
  });

  it('appends a new color and leaves the oldest hex on the canvas', () => {
    let palette = createDocument(2, 2).palette;
    let order = [1];
    for (let i = 0; i < 7; i++) {
      const picked = pickRecentColor(palette, order, `#01010${i}`);
      expect(picked).not.toBeNull();
      palette = picked!.palette;
      order = picked!.order;
    }
    expect(palette).toHaveLength(8);
    const added = pickRecentColor(palette, order, '#abcdef');
    expect(added?.palette).toHaveLength(9);
    expect(added?.palette[0]?.hex).toBe('#000000');
    expect(added?.slot).toBe(9);
    expect(added?.order).toHaveLength(9);
    expect(added?.order[0]).toBe(1);
  });
});

describe('recolor and delete', () => {
  it('does not recolor the canvas when a new color is chosen', () => {
    const editor = session();
    editor.doc.cells[0] = 1;
    editor.useColor('#112233');
    expect(editor.doc.cells[0]).toBe(1);
    expect(editor.doc.palette[0]?.hex).toBe('#000000');
    expect(editor.doc.palette[1]?.hex).toBe('#112233');
    expect(editor.colorSlot).toBe(2);
  });

  it('hides a used color from the list and leaves the stitches', () => {
    const editor = session();
    editor.doc.palette.push({ id: 'clay', name: 'Глина', hex: '#be6437' });
    editor.doc.cells[0] = 1;
    editor.doc.cells[1] = 2;
    editor.setColorSlot(1);
    expect(editor.dismissColor(0)).toBe(true);
    expect(editor.doc.palette[0]?.hidden).toBe(true);
    expect(editor.doc.palette[0]?.hex).toBe('#000000');
    expect(editor.doc.cells[0]).toBe(1);
    expect(editor.doc.cells[1]).toBe(2);
    expect(editor.colorSlot).toBe(2);
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

  it('copies a selection exactly at 90, 180, 270 and 360 degrees', () => {
    const editor = session(8, 8);
    const rect = { x: 2, y: 2, width: 3, height: 2 };
    const pattern = [1, 2, 3, 4, 5, 6];
    paint(editor, rect, pattern);
    const original = editor.doc.cells.slice();
    editor.selection = { ...rect };

    turn(editor, 0);
    turn(editor, Math.PI * 2);
    expect([...editor.doc.cells]).toEqual([...original]);
    expect(editor.selection).toEqual(rect);

    turn(editor, Math.PI / 2);
    expect(editor.selection).toEqual({ x: 2, y: 2, width: 2, height: 3 });
    expect(taken(editor, editor.selection)).toEqual([4, 1, 5, 2, 6, 3]);
    expect(tally(editor.doc.cells)).toEqual(tally(original));
    editor.undo();
    expect([...editor.doc.cells]).toEqual([...original]);
    editor.selection = { ...rect };

    turn(editor, Math.PI);
    expect(editor.selection).toEqual(rect);
    expect(taken(editor, rect)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(tally(editor.doc.cells)).toEqual(tally(original));
    editor.undo();
    editor.selection = { ...rect };

    turn(editor, (Math.PI * 3) / 2);
    expect(taken(editor, editor.selection)).toEqual([3, 6, 2, 5, 1, 4]);
    expect(tally(editor.doc.cells)).toEqual(tally(original));
    editor.undo();
    editor.selection = { ...rect };

    for (let step = 0; step < 4; step += 1) turn(editor, Math.PI / 2);
    expect([...editor.doc.cells]).toEqual([...original]);
    expect(editor.selection).toEqual(rect);

    const edge = session(8, 8);
    const edgeRect = { x: 0, y: 0, width: 2, height: 5 };
    paint(edge, edgeRect, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const edgeBefore = edge.doc.cells.slice();
    edge.selection = { ...edgeRect };
    turn(edge, Math.PI / 2);
    expect(tally(edge.doc.cells)).toEqual(tally(edgeBefore));

    paint(editor, rect, pattern);
    editor.selection = { ...rect };
    const spun = rotateRegion(editor.doc.cells, 8, 8, rect, Uint16Array.from(pattern), Math.PI / 7);
    const allowed = new Set([0, 1, 2, 3, 4, 5, 6]);
    for (const patch of spun.patches) expect(allowed.has(patch.after)).toBe(true);
    expect(snapRotation((88 * Math.PI) / 180)).toBeCloseTo(Math.PI / 2);
    expect(snapRotation((80 * Math.PI) / 180)).toBeCloseTo((80 * Math.PI) / 180);
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
    expect(editor.selection).toMatchObject({ x: 3, y: 1, width: 1, height: 1 });
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
    expect(editor.notice).toBeNull();
    editor.movePaste(3, 0);
    editor.confirmPaste();
    expect(editor.pasteClipped).toBe(true);
    expect(editor.doc.palette.filter((color) => color.hex === '#112233')).toHaveLength(1);
    expect(editor.doc.cells[0]).toBe(2);
    expect(editor.doc.cells[3]).toBe(2);
    expect([...editor.doc.cells].filter((cell) => cell !== 0)).toEqual([2, 2]);
  });

  it('stamps the clipboard across both symmetry axes', () => {
    const editor = session(8, 8);
    editor.doc.symmetry = { mode: 'both', axisX2: 4, axisY2: 4, showAxes: true };
    editor.clipboard = {
      schemaVersion: 1,
      width: 1,
      height: 1,
      cells: new Uint16Array([1]),
      palette: editor.doc.palette,
    };
    editor.beginPaste();
    editor.confirmPaste();
    expect(editor.doc.cells[0]).toBe(1);
    expect(editor.doc.cells[3]).toBe(1);
    expect(editor.doc.cells[3 * 8]).toBe(1);
    expect(editor.doc.cells[3 * 8 + 3]).toBe(1);
    expect(editor.selection).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('keeps a paste off the rug until it is confirmed', () => {
    const editor = session();
    const rect = { x: 0, y: 0, width: 2, height: 2 };
    paint(editor, rect, [1, 0, 0, 0]);
    editor.selection = { ...rect };
    editor.copySelection();
    const before = editor.doc.cells.slice();
    editor.beginPaste();
    editor.movePaste(2, 1);
    editor.flipSelection('horizontal');
    expect(editor.doc.cells).toEqual(before);
    expect([...(editor.clipboard?.cells ?? [])]).toEqual([1, 0, 0, 0]);
    editor.cancelPaste();
    expect(editor.pasteOrigin).toBeNull();
    expect(editor.doc.cells).toEqual(before);
    editor.beginPaste();
    editor.startPasteScale();
    editor.previewPasteScale('e', { x: 3, y: 1 });
    editor.finishPasteEdit();
    expect(editor.pasteWidth).toBe(4);
    expect(editor.doc.cells).toEqual(before);
    editor.cancelPaste();
    editor.beginPaste();
    editor.movePaste(2, 1);
    editor.flipSelection('horizontal');
    editor.startPasteRotate();
    editor.previewPasteRotate(Math.PI / 2);
    editor.finishPasteEdit();
    expect(editor.doc.cells).toEqual(before);
    editor.confirmPaste();
    expect(taken(editor, { x: 2, y: 1, width: 2, height: 2 })).toEqual([0, 0, 0, 1]);
    expect(editor.doc.cells[0]).toBe(1);
    expect(editor.pasteOrigin).toBeNull();
    expect(editor.history.undo).toHaveLength(1);
    expect([...(editor.clipboard?.cells ?? [])]).toEqual([1, 0, 0, 0]);
  });

  it('flips the stitches inside the selection in one undo step', () => {
    const editor = session();
    const rect = { x: 1, y: 1, width: 3, height: 2 };
    paint(editor, rect, [1, 2, 3, 4, 5, 6]);
    editor.selection = { ...rect };
    editor.flipSelection('horizontal');
    expect(taken(editor, rect)).toEqual([3, 2, 1, 6, 5, 4]);
    editor.undo();
    expect(taken(editor, rect)).toEqual([1, 2, 3, 4, 5, 6]);
    editor.flipSelection('vertical');
    expect(taken(editor, rect)).toEqual([4, 5, 6, 1, 2, 3]);
    expect(editor.selection).toEqual(rect);
    expect(editor.history.undo).toHaveLength(1);
  });

  it('paints and unselects arbitrary shapes using mask brush, and toggles selection on repeated clicks', () => {
    const editor = session(10, 10);
    editor.setTool('lasso');

    // First stroke: start at (1, 1), drag to (1, 3)
    editor.pointerDown({ x: 1, y: 1 });
    editor.pointerMove({ x: 1, y: 3 });
    editor.pointerUp();

    expect(editor.selection).not.toBeNull();
    expect(editor.selection?.x).toBe(1);
    expect(editor.selection?.y).toBe(1);
    expect(editor.selection?.width).toBe(1);
    expect(editor.selection?.height).toBe(3);
    expect(editor.selection?.mask).toEqual(new Uint8Array([1, 1, 1]));

    // Second stroke: expand selection by painting at (2, 3) and (3, 3)
    editor.pointerDown({ x: 2, y: 3 });
    editor.pointerMove({ x: 3, y: 3 });
    editor.pointerUp();

    expect(editor.selection?.x).toBe(1);
    expect(editor.selection?.y).toBe(1);
    expect(editor.selection?.width).toBe(3);
    expect(editor.selection?.height).toBe(3);

    // Verify (1, 1), (1, 2), (1, 3), (2, 3), (3, 3) are selected
    expect(editor.selection?.mask?.[0]).toBe(1); // (1, 1)
    expect(editor.selection?.mask?.[1 * 3 + 0]).toBe(1); // (1, 2)
    expect(editor.selection?.mask?.[2 * 3 + 0]).toBe(1); // (1, 3)
    expect(editor.selection?.mask?.[2 * 3 + 1]).toBe(1); // (2, 3)
    expect(editor.selection?.mask?.[2 * 3 + 2]).toBe(1); // (3, 3)
    // (2, 2) is unselected (0)
    expect(editor.selection?.mask?.[1 * 3 + 1]).toBe(0);

    // Repeated click on already selected cell (1, 2) unselects it
    editor.pointerDown({ x: 1, y: 2 });
    editor.pointerUp();

    expect(editor.selection?.mask?.[1 * 3 + 0]).toBe(0); // (1, 2) unselected
    expect(editor.selection?.mask?.[0]).toBe(1); // (1, 1) still selected
    expect(editor.selection?.mask?.[2 * 3 + 0]).toBe(1); // (1, 3) still selected

    // Deselect clears the selection
    editor.deselect();
    expect(editor.selection).toBeNull();
  });

  it('moves only the masked stitches of an arbitrary shape selection', () => {
    const editor = session(10, 10);
    // Fill background with color 9, and draw shape with color 1
    for (let i = 0; i < 100; i++) editor.doc.cells[i] = 9;

    // Create a triangle mask on cells (0,0), (1,0), (0,1)
    const tri = fillLasso([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]);
    editor.doc.cells[0] = 1;
    editor.doc.cells[1] = 1;
    editor.doc.cells[10] = 1;
    editor.doc.cells[11] = 2; // (1, 1) is not in triangle mask

    editor.setTool('select');
    editor.selection = {
      x: tri.x,
      y: tri.y,
      width: tri.width,
      height: tri.height,
      mask: tri.mask,
    };

    // Drag move the selection by dx=+3, dy=+2
    editor.pointerDown({ x: 0, y: 0 }); // click inside selection
    editor.pointerMove({ x: 3, y: 2 });
    editor.pointerUp();

    // Destination cells receive the moved values
    expect(editor.doc.cells[2 * 10 + 3]).toBe(1);
    expect(editor.doc.cells[2 * 10 + 4]).toBe(1);
    expect(editor.doc.cells[3 * 10 + 3]).toBe(1);

    // Source masked cells became 0
    expect(editor.doc.cells[0]).toBe(0);
    expect(editor.doc.cells[1]).toBe(0);
    expect(editor.doc.cells[10]).toBe(0);

    // Cell (1, 1) was NOT in the mask, so it stayed 2!
    expect(editor.doc.cells[11]).toBe(2);

    // And selection bounding box moved
    expect(editor.selection?.x).toBe(3);
    expect(editor.selection?.y).toBe(2);
  });

  it('copies, cuts and flips an arbitrary shape selection with mask', () => {
    const editor = session(6, 6);
    // Triangle: (1,1), (2,1), (1,2)
    const tri = fillLasso([{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }]);
    editor.doc.cells[1 * 6 + 1] = 3;
    editor.doc.cells[1 * 6 + 2] = 4;
    editor.doc.cells[2 * 6 + 1] = 5;
    editor.doc.cells[2 * 6 + 2] = 9; // Outside mask in bounding box

    editor.setTool('lasso');
    editor.selection = {
      x: tri.x,
      y: tri.y,
      width: tri.width,
      height: tri.height,
      mask: tri.mask,
    };

    // Copy selection
    editor.copySelection();
    expect(editor.clipboard?.cells[0]).toBe(3);
    expect(editor.clipboard?.cells[1]).toBe(4);
    expect(editor.clipboard?.cells[1 * 2 + 0]).toBe(5);
    // Unmasked cell in clipboard is 0
    expect(editor.clipboard?.cells[1 * 2 + 1]).toBe(0);

    // Flip horizontally
    editor.flipSelection('horizontal');
    // Horizontally mirrored: (2, 1) becomes 3, (1, 1) becomes 4, (2, 2) becomes 5
    expect(editor.doc.cells[1 * 6 + 2]).toBe(3);
    expect(editor.doc.cells[1 * 6 + 1]).toBe(4);
    expect(editor.doc.cells[2 * 6 + 2]).toBe(5);
    // Source (1, 2) became 0
    expect(editor.doc.cells[2 * 6 + 1]).toBe(0);
    // (2, 2) originally had 9, replaced by 5 from the flip; cell outside mask untouched
    expect(editor.selection?.mask).toBeDefined();

    // Clear selection
    editor.clearSelection();
    expect(editor.doc.cells[1 * 6 + 2]).toBe(0);
    expect(editor.doc.cells[1 * 6 + 1]).toBe(0);
    expect(editor.doc.cells[2 * 6 + 2]).toBe(0);
  });

  it('keeps the arbitrary shape mask during paste and after confirm', () => {
    const editor = session(8, 8);
    // Draw an L-shaped motif
    const lShape = fillLasso([{ x: 1, y: 1 }, { x: 1, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 1 }]);
    for (const pt of lShape.points) {
      editor.doc.cells[pt.y * 8 + pt.x] = 1;
    }

    editor.setTool('lasso');
    editor.selection = {
      x: lShape.x,
      y: lShape.y,
      width: lShape.width,
      height: lShape.height,
      mask: lShape.mask,
    };

    editor.copySelection();
    expect(editor.clipboard?.mask).toBeDefined();

    // Paste
    editor.beginPaste();
    const pRect = editor.pasteRect();
    expect(pRect?.mask).toBeDefined();
    expect(pRect?.mask).toEqual(lShape.mask);

    // Move paste
    editor.movePaste(4, 0);
    expect(editor.pasteRect()?.x).toBe(lShape.x + 4);
    expect(editor.pasteRect()?.mask).toBeDefined();

    // Confirm paste
    editor.confirmPaste();
    expect(editor.selection).not.toBeNull();
    expect(editor.selection?.mask).toBeDefined();
    expect(editor.selection?.x).toBe(lShape.x + 4);
    expect(editor.selection?.width).toBe(lShape.width);
    expect(editor.selection?.height).toBe(lShape.height);

    // Verify cell inside mask was pasted
    expect(editor.doc.cells[1 * 8 + (1 + 4)]).toBe(1);
    // Verify cell outside mask within bounding box is empty (0)
    expect(editor.doc.cells[1 * 8 + (3 + 4)]).toBe(0);
  });

  it('does not zero out background drawings outside the selection mask when pasting an arbitrary shape', () => {
    const editor = session(8, 8);
    // Fill canvas background with color 1
    editor.doc.cells.fill(1);

    // Add a second color to the palette for distinction
    editor.doc.palette = [
      ...editor.doc.palette,
      { id: 'c2', name: 'Color 2', hex: '#ff0000' },
    ];

    // L-shape mask: 2x2 bounding box at (0, 0)
    // [1, 1]
    // [1, 0]
    const mask = new Uint8Array([1, 1, 1, 0]);
    editor.selection = {
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      mask,
    };
    // Paint slot 2 into the masked cells
    editor.doc.cells[0] = 2;
    editor.doc.cells[1] = 2;
    editor.doc.cells[1 * 8 + 0] = 2;

    editor.copySelection();
    editor.beginPaste();
    editor.movePaste(4, 4);
    editor.confirmPaste();

    // Cells inside the mask at destination (4, 4), (5, 4), (4, 5) should be updated to slot 2
    expect(editor.doc.cells[4 * 8 + 4]).toBe(2);
    expect(editor.doc.cells[4 * 8 + 5]).toBe(2);
    expect(editor.doc.cells[5 * 8 + 4]).toBe(2);

    // Cell outside mask at destination (5, 5) within bounding box must remain background color 1 (NOT zeroed out)
    expect(editor.doc.cells[5 * 8 + 5]).toBe(1);

    // Other background cells remain intact
    expect(editor.doc.cells[3 * 8 + 3]).toBe(1);
    expect(editor.doc.cells[6 * 8 + 6]).toBe(1);
  });

  it('selects all connected pixels of the same color with selectFill and toggles selection on repeated click', () => {
    const editor = session(10, 10);
    // Draw a 3x3 square of color 1 at (2, 2)
    for (let y = 2; y <= 4; y++) {
      for (let x = 2; x <= 4; x++) {
        editor.doc.cells[y * 10 + x] = 1;
      }
    }
    // And an isolated pixel of color 1 at (8, 8)
    editor.doc.cells[8 * 10 + 8] = 1;

    editor.setTool('selectFill');
    editor.pointerDown({ x: 3, y: 3 });

    // Should have selected the 3x3 square (9 cells)
    expect(editor.selection).not.toBeNull();
    expect(editor.selection?.x).toBe(2);
    expect(editor.selection?.y).toBe(2);
    expect(editor.selection?.width).toBe(3);
    expect(editor.selection?.height).toBe(3);
    expect(editor.selection?.mask).toEqual(new Uint8Array(9).fill(1));

    // Isolated pixel at (8, 8) was not 4-connected, so not selected
    const set = getSelectionCellSet(editor.selection, 10, 10);
    expect(set.has(8 * 10 + 8)).toBe(false);

    // Repeated click on the selected square unselects it
    editor.pointerDown({ x: 3, y: 3 });
    expect(editor.selection).toBeNull();
  });

  it('combines selectFill and lasso brush iteratively without losing selection', () => {
    const editor = session(10, 10);
    // Object 1: color 1 at (1, 1), (1, 2)
    editor.doc.cells[1 * 10 + 1] = 1;
    editor.doc.cells[2 * 10 + 1] = 1;
    // Object 2: color 2 at (5, 5), (5, 6)
    editor.doc.cells[5 * 10 + 5] = 2;
    editor.doc.cells[6 * 10 + 5] = 2;

    // 1. Flood select Object 1
    editor.setTool('selectFill');
    editor.pointerDown({ x: 1, y: 1 });
    let set = getSelectionCellSet(editor.selection, 10, 10);
    expect(set.size).toBe(2);
    expect(set.has(1 * 10 + 1)).toBe(true);
    expect(set.has(2 * 10 + 1)).toBe(true);

    // 2. Switch to lasso and brush-select an extra pixel at (3, 3)
    editor.setTool('lasso');
    expect(editor.selection).not.toBeNull();
    editor.pointerDown({ x: 3, y: 3 });
    editor.pointerUp();
    set = getSelectionCellSet(editor.selection, 10, 10);
    expect(set.size).toBe(3);
    expect(set.has(3 * 10 + 3)).toBe(true);

    // 3. Switch back to selectFill and flood select Object 2
    editor.setTool('selectFill');
    expect(editor.selection).not.toBeNull();
    editor.pointerDown({ x: 5, y: 5 });
    set = getSelectionCellSet(editor.selection, 10, 10);
    expect(set.size).toBe(5);
    expect(set.has(5 * 10 + 5)).toBe(true);
    expect(set.has(6 * 10 + 5)).toBe(true);
    expect(set.has(1 * 10 + 1)).toBe(true);
    expect(set.has(3 * 10 + 3)).toBe(true);
  });

  it('mirrors selectFill across symmetry axes', () => {
    const editor = session(10, 10);
    editor.doc.symmetry = { mode: 'vertical', axisX2: 10, axisY2: 0, showAxes: true };
    // Left patch: (1, 1) color 1
    editor.doc.cells[1 * 10 + 1] = 1;
    // Right reflected patch: (8, 1) color 1
    editor.doc.cells[1 * 10 + 8] = 1;

    editor.setTool('selectFill');
    editor.pointerDown({ x: 1, y: 1 });

    const set = getSelectionCellSet(editor.selection, 10, 10);
    expect(set.has(1 * 10 + 1)).toBe(true);
    expect(set.has(1 * 10 + 8)).toBe(true);
    expect(set.size).toBe(2);
  });

  it('seamlessly combines rectangular select, lasso brush, and selectFill into one unified selection', () => {
    const editor = session(20, 20);
    // 1. Select a 3x3 rectangle at (1, 1) using 'select'
    editor.setTool('select');
    editor.pointerDown({ x: 1, y: 1 });
    editor.pointerMove({ x: 3, y: 3 });
    editor.pointerUp();
    let set = getSelectionCellSet(editor.selection, 20, 20);
    expect(set.size).toBe(9);

    // 2. Switch to 'lasso' and brush an extra pixel at (5, 5)
    editor.setTool('lasso');
    expect(editor.selection).not.toBeNull();
    editor.pointerDown({ x: 5, y: 5 });
    editor.pointerUp();
    set = getSelectionCellSet(editor.selection, 20, 20);
    expect(set.size).toBe(10);
    expect(set.has(5 * 20 + 5)).toBe(true);

    // 3. Switch to 'selectFill' and flood-select a 2x2 shape of color 2 at (10, 10)
    editor.doc.cells[10 * 20 + 10] = 2;
    editor.doc.cells[10 * 20 + 11] = 2;
    editor.doc.cells[11 * 20 + 10] = 2;
    editor.doc.cells[11 * 20 + 11] = 2;

    editor.setTool('selectFill');
    expect(editor.selection).not.toBeNull();
    editor.pointerDown({ x: 10, y: 10 });
    set = getSelectionCellSet(editor.selection, 20, 20);
    expect(set.size).toBe(14);
    expect(set.has(10 * 20 + 10)).toBe(true);

    // 4. Switch back to 'select' and drag another rectangle at (15, 15) to (16, 16)
    editor.setTool('select');
    expect(editor.selection).not.toBeNull();
    editor.pointerDown({ x: 15, y: 15 });
    editor.pointerMove({ x: 16, y: 16 });
    editor.pointerUp();
    set = getSelectionCellSet(editor.selection, 20, 20);
    expect(set.size).toBe(18);
    expect(set.has(15 * 20 + 15)).toBe(true);
    expect(set.has(16 * 20 + 16)).toBe(true);

    // 5. Drag to move the unified selection
    editor.pointerDown({ x: 1, y: 1 });
    editor.pointerMove({ x: 2, y: 1 });
    editor.pointerUp();
    expect(editor.selection?.x).toBe(2);
  });
});

function paint(
  editor: EditorSession,
  rect: { x: number; y: number; width: number; height: number },
  values: number[],
): void {
  for (let i = 0; i < values.length; i += 1) {
    const x = rect.x + (i % rect.width);
    const y = rect.y + Math.floor(i / rect.width);
    editor.doc.cells[y * editor.doc.width + x] = values[i] ?? 0;
  }
}

function turn(editor: EditorSession, radians: number): void {
  editor.startRotate();
  editor.previewRotate(radians);
  editor.commitRotate();
}

function taken(
  editor: EditorSession,
  rect: { x: number; y: number; width: number; height: number } | null,
): number[] {
  if (!rect) return [];
  const out: number[] = [];
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) out.push(editor.doc.cells[(rect.y + y) * editor.doc.width + rect.x + x] ?? 0);
  }
  return out;
}

function tally(cells: ArrayLike<number>): number[] {
  return Array.from(cells).sort((a, b) => a - b);
}

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
