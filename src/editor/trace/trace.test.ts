import { describe, expect, it } from 'vitest';
import { fitFrame, gripAt, placeTrace, toLocal, type SourceCrop, type TraceFrame } from './trace.ts';

const full: SourceCrop = { x: 0, y: 0, width: 1, height: 1 };
const frame: TraceFrame = { x: 0, y: 0, width: 100, height: 50, rotation: 0 };

describe('tracing pictures', () => {
  it('fits a picture inside the canvas without stretching it', () => {
    const fitted = fitFrame(100, 100, 200, 100);
    expect(fitted.width / fitted.height).toBeCloseTo(2);
    expect(fitted.x).toBeGreaterThanOrEqual(0);
    expect(fitted.y).toBeGreaterThanOrEqual(0);
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(100);
    expect(fitted.y + fitted.height).toBeLessThanOrEqual(100);
  });

  it('keeps the opposite corner put while a corner scales the picture', () => {
    const next = placeTrace(frame, full, 'se', 200, 100, 0, 0);
    expect(next.frame.width / next.frame.height).toBeCloseTo(2);
    expect(next.frame.x).toBeCloseTo(0);
    expect(next.frame.y).toBeCloseTo(0);
    expect(next.frame.width).toBeCloseTo(200);
    expect(next.crop).toEqual(full);
  });

  it('trims the source from the right and leaves the left edge where it was', () => {
    const next = placeTrace(frame, full, 'e', 80, 25, 0, 0);
    expect(next.frame.x).toBeCloseTo(0);
    expect(next.frame.width).toBeCloseTo(80);
    expect(next.crop.x).toBeCloseTo(0);
    expect(next.crop.width).toBeCloseTo(0.8);
    expect(next.crop.height).toBeCloseTo(1);
  });

  it('points the top of the picture at the pointer', () => {
    const upright = placeTrace(frame, full, 'rotate', 50, 0, 0, 0);
    expect(upright.frame.rotation).toBeCloseTo(0);
    const turned = placeTrace(frame, full, 'rotate', 80, 25, 0, 0);
    expect(turned.frame.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('reads a rotated point back into the picture', () => {
    const local = toLocal({ ...frame, rotation: Math.PI / 2 }, 75, 25);
    expect(local.x).toBeCloseTo(0);
    expect(local.y).toBeCloseTo(-25);
  });

  it('hits the corner before the inside', () => {
    expect(gripAt(frame, 50, 25, 2)).toBe('body');
    expect(gripAt(frame, 100, 50, 2)).toBe('se');
    expect(gripAt(frame, 50, -1, 2)).toBe('n');
  });
});
