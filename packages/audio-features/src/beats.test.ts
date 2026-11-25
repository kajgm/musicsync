import { describe, expect, it } from 'vitest';
import { BeatTracker, type BeatEstimate } from './beats.ts';

/** Feeds a click track (one click per beat, light noise in between) at 10 ms frames. */
function run(bpm: number, opts: { ms?: number; phase?: number; skip?: (beat: number) => boolean; noise?: number } = {}) {
  const tracker = new BeatTracker();
  const period = 60_000 / bpm;
  const phase = opts.phase ?? 37;
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let last: BeatEstimate | undefined;
  for (let t = 0; t < (opts.ms ?? 12_000); t += 10) {
    const beat = Math.round((t - phase) / period);
    const onBeat = Math.abs(t - phase - beat * period) < 5 && !(opts.skip?.(beat) ?? false);
    last = tracker.push(onBeat ? 10 : (opts.noise ?? 0.3) * rand(), t) ?? last;
  }
  return { last, period, phase };
}

/** Distance of t from the nearest beat, ms. */
const offGrid = (t: number, period: number, phase: number) => {
  const d = (((t - phase) % period) + period) % period;
  return Math.min(d, period - d);
};

describe('BeatTracker', () => {
  for (const bpm of [92, 120, 128, 150]) {
    it(`finds ${bpm} BPM and where the beats fall`, () => {
      const { last, period, phase } = run(bpm);
      expect(last).toBeDefined();
      expect(Math.abs(last!.periodMs - period)).toBeLessThan(period * 0.02);
      expect(offGrid(last!.anchorT, period, phase)).toBeLessThan(20);
      expect(last!.confidence).toBeGreaterThan(0.4);
    });
  }

  it('keeps the beat with one beat in four missing', () => {
    const { last, period, phase } = run(120, { skip: (b) => b % 4 === 3 });
    expect(Math.abs(last!.periodMs - period)).toBeLessThan(10);
    expect(offGrid(last!.anchorT, period, phase)).toBeLessThan(20);
  });

  it('keeps the tempo through a short quiet passage', () => {
    const { last, period } = run(124, { ms: 14_000, skip: (b) => b >= 20 && b < 24 });
    expect(Math.abs(last!.periodMs - period)).toBeLessThan(10);
  });

  it('is unsure about noise', () => {
    const tracker = new BeatTracker();
    let seed = 7;
    let last: BeatEstimate | undefined;
    for (let t = 0; t < 12_000; t += 10) last = tracker.push(10 * ((seed = (seed * 16807) % 2147483647) / 2147483647) ** 4, t) ?? last;
    expect(last?.confidence ?? 0).toBeLessThan(0.3);
  });
});
