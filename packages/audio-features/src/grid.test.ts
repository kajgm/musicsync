import { describe, expect, it } from 'vitest';
import { fitGrid, gridFromTaps, mergeGrid } from './grid.ts';

const offBy = (a: number, b: number, period: number) => {
  const d = Math.abs(a - b) % period;
  return Math.min(d, period - d);
};

describe('fitGrid', () => {
  it('fits observations scattered around the beat, ignoring a stray tempo', () => {
    const obs = Array.from({ length: 40 }, (_, i) => ({ periodMs: 500 + ((i % 5) - 2), posMs: 120 + i * 500 + ((i * 37) % 21) - 10, weight: 1 }));
    obs.push({ periodMs: 250, posMs: 9999, weight: 1 });
    const g = fitGrid(obs)!;
    expect(g.periodMs).toBeCloseTo(500, 0);
    expect(offBy(g.offsetMs, 120, 500)).toBeLessThan(5);
    expect(g.confidence).toBeGreaterThan(0.9);
  });

  it('needs enough observations', () => {
    expect(fitGrid([{ periodMs: 500, posMs: 0, weight: 1 }])).toBeUndefined();
  });
});

describe('mergeGrid', () => {
  it('averages plays at the same tempo, across the wrap', () => {
    const a = { periodMs: 500, offsetMs: 495, confidence: 0.9, count: 100 };
    const b = { periodMs: 500, offsetMs: 5, confidence: 0.9, count: 100 };
    const m = mergeGrid(a, b);
    expect(offBy(m.offsetMs, 0, 500)).toBeLessThan(2);
    expect(m.count).toBe(200);
  });

  it('keeps the better grid when the tempo disagrees', () => {
    const good = { periodMs: 500, offsetMs: 0, confidence: 0.9, count: 300 };
    const doubled = { periodMs: 250, offsetMs: 0, confidence: 0.5, count: 30 };
    expect(mergeGrid(good, doubled)).toBe(good);
  });
});

describe('gridFromTaps', () => {
  it('fits sloppy taps, including a skipped beat', () => {
    const taps = [0, 1, 2, 3, 5, 6, 7, 8, 9].map((k, i) => 1000 + k * 476 + [8, -12, 15, -5, 0, 10, -14, 6, -3][i]);
    const g = gridFromTaps(taps)!;
    expect(g.periodMs).toBeGreaterThan(470);
    expect(g.periodMs).toBeLessThan(482);
    expect(offBy(g.offsetMs, 1000, g.periodMs)).toBeLessThan(15);
  });

  it('needs 8 taps', () => {
    expect(gridFromTaps([0, 500, 1000])).toBeUndefined();
  });
});
