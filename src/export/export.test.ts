import { describe, expect, it } from 'vitest';
import { createDocument } from '../editor/canvas/grid.ts';
import { collectKeys, exportProjectFile, parseProjectFile } from './json.ts';
import { pngBytes, renderRgba, rugPreview } from './png.ts';

describe('png export', () => {
  it('is deterministic and keeps grid and checkerboard independent', () => {
    const doc = createDocument(2, 2);
    doc.cells[0] = 1;
    const clean = renderRgba(doc, { grid: false, checker: false, pixelsPerCell: 4, border: false, checkerBlock: 1 });
    expect(clean.width).toBe(8);
    expect(clean.height).toBe(8);
    expect([clean.data[0], clean.data[1], clean.data[2], clean.data[3]]).toEqual([26, 22, 20, 255]);
    const interior = (5 * 8 + 5) * 4;
    expect(clean.data[interior + 3]).toBe(0);
    const checker = renderRgba(doc, { grid: false, checker: true, pixelsPerCell: 4, border: false, checkerBlock: 1 });
    expect(checker.data[interior + 3]).toBe(255);
    const grid = renderRgba(doc, { grid: true, checker: false, pixelsPerCell: 4, border: false, checkerBlock: 1 });
    expect([grid.data[0], grid.data[1], grid.data[2]]).toEqual([42, 34, 28]);
    expect([grid.data[(1 * 8 + 1) * 4], grid.data[(1 * 8 + 1) * 4 + 1], grid.data[(1 * 8 + 1) * 4 + 2]]).toEqual([
      26, 22, 20,
    ]);
    const once = pngBytes(doc, { grid: true, checker: true, pixelsPerCell: 3, border: false, checkerBlock: 2 });
    const twice = pngBytes(doc, { grid: true, checker: true, pixelsPerCell: 3, border: false, checkerBlock: 2 });
    expect([...once]).toEqual([...twice]);
    expect(once[0]).toBe(137);
  });

  it('copies rug rows into the preview without wrapping them', () => {
    const doc = createDocument(100, 8);
    doc.cells[100] = 1;
    const image = rugPreview(doc, 216);
    expect(image.width).toBe(200);
    expect(image.height).toBe(16);
    const pixel = (x: number, y: number) => {
      const index = (y * image.width + x) * 4;
      return [image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3]];
    };
    expect(pixel(0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(0, 2)).toEqual([26, 22, 20, 255]);
    expect(pixel(1, 2)).toEqual([26, 22, 20, 255]);
    expect(pixel(2, 2)[3]).toBe(0);
    const wide = createDocument(13, 2);
    wide.cells[13] = 1;
    const rows = rugPreview(wide, 200);
    expect(rows.width % 13).toBe(0);
    expect(rows.data[3]).toBe(0);
    expect(rows.data[(rows.width * (rows.height / 2)) * 4 + 3]).toBe(255);
  });
});

describe('json project files', () => {
  it('round-trips an editable project and rejects secrets, damage, and unknown schemas', () => {
    const doc = createDocument(3, 2);
    doc.cells[1] = 1;
    doc.symmetry = { mode: 'horizontal', axisX2: 3, axisY2: 1, showAxes: true };
    const text = exportProjectFile('project-1', 'Ковёр', doc);
    const keys = collectKeys(JSON.parse(text));
    for (const forbidden of ['token', 'password', 'service_role', 'storageobjectpath']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    const parsed = parseProjectFile(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.cells[1]).toBe(1);
      expect(parsed.file.projectId).toBe('project-1');
      expect(parsed.file.symmetry.mode).toBe('horizontal');
    }
    expect(parseProjectFile('{').ok).toBe(false);
    expect(parseProjectFile(JSON.stringify({ schemaVersion: 9, name: 'x' })).ok).toBe(false);
    expect(parseProjectFile(JSON.stringify({ schemaVersion: 1, token: 'secret' })).ok).toBe(false);
  });
});
