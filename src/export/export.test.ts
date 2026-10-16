import { describe, expect, it } from 'vitest';
import { createDocument } from '../editor/canvas/grid.ts';
import { collectKeys, exportProjectFile, parseProjectFile } from './json.ts';
import { pngBytes, renderRgba } from './png.ts';

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
