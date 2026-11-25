import { describe, expect, it } from 'vitest';
import { Engine, FlashLimiter } from './index.ts';

const master = { brightness: 1, intensity: 1, blackout: false };
const peak = (rgb: Float32Array, ch = 0) => Math.max(rgb[ch * 3], rgb[ch * 3 + 1], rgb[ch * 3 + 2]);

/** Counts rises of more than `threshold` from the preceding trough. */
function countRises(levels: number[], threshold: number): number {
  let trough = levels[0];
  let count = 0;
  for (const level of levels) {
    if (level < trough) trough = level;
    else if (level - trough > threshold) {
      count++;
      trough = level;
    }
  }
  return count;
}

describe('Engine', () => {
  it('is deterministic', () => {
    const run = () => {
      const engine = new Engine(3);
      const frames: number[] = [];
      for (let t = 0; t < 2000; t += 20) {
        engine.audio(t, { level: 0.5, bass: (t % 500) / 500 });
        if (t % 500 === 0) engine.onset(t);
        frames.push(...engine.render(t, master));
      }
      return frames;
    };
    expect(run()).toEqual(run());
  });

  it('flashes on a kick and decays afterwards', () => {
    const engine = new Engine(1);
    for (let t = 0; t < 1000; t += 20) {
      engine.audio(t, { level: 0.2, bass: 0 });
      engine.render(t, master);
    }
    const before = peak(engine.render(1000, master));
    engine.audio(1020, { level: 0.2, bass: 0 });
    engine.onset(1020);
    const flash = peak(engine.render(1020, master));
    let after = 0;
    for (let t = 1040; t < 1600; t += 20) {
      engine.audio(t, { level: 0.2, bass: 0 });
      after = peak(engine.render(t, master));
    }
    expect(flash).toBeGreaterThan(before + 0.5);
    expect(after).toBeLessThan(flash - 0.5);
  });

  it('is dark on blackout and steady at zero intensity', () => {
    const engine = new Engine(2);
    engine.audio(0, { level: 1, bass: 1 });
    engine.onset(0);
    expect([...engine.render(0, { ...master, blackout: true })].every((v) => v === 0)).toBe(true);

    const calm = new Engine(1);
    const levels: number[] = [];
    for (let t = 0; t < 3000; t += 20) {
      calm.audio(t, { level: 1, bass: (t / 20) % 2 });
      if (t % 400 === 0) calm.onset(t);
      levels.push(peak(calm.render(t, { ...master, intensity: 0 })));
    }
    expect(countRises(levels, 0.25)).toBe(0);
  });

  it('ripples a kick outward in Wave, and all at once in Pulse', () => {
    const near = { x: 0.1, y: 0.1, z: 0 };
    const far = { x: 1, y: 1, z: 1 };
    const peakTimes = (look: 'pulse' | 'wave') => {
      const engine = new Engine([near, far]);
      const best = [{ t: 0, v: 0 }, { t: 0, v: 0 }];
      for (let t = 0; t < 1000; t += 10) {
        engine.audio(t, { level: 0.2, bass: 0 });
        if (t === 500) engine.onset(t);
        const rgb = engine.render(t, { ...master, look });
        for (const ch of [0, 1]) if (peak(rgb, ch) > best[ch].v) best[ch] = { t, v: peak(rgb, ch) };
      }
      return best.map((b) => b.t);
    };
    const [pNear, pFar] = peakTimes('pulse');
    expect(pFar).toBe(pNear);
    const [wNear, wFar] = peakTimes('wave');
    expect(wFar - wNear).toBeGreaterThanOrEqual(200);
  });

  it('scales each channel by its group fader', () => {
    const engine = new Engine(2);
    engine.setGains([1, 0.25]);
    const rgb = engine.render(0, master);
    expect(peak(rgb, 1)).toBeLessThan(peak(rgb, 0) * 0.5);
  });

  it('breathes without audio', () => {
    const engine = new Engine(1);
    const levels: number[] = [];
    for (let t = 0; t < 7000; t += 20) levels.push(peak(engine.render(t, master)));
    expect(Math.min(...levels)).toBeGreaterThan(0.1);
    expect(Math.max(...levels)).toBeLessThan(0.5);
  });
});

describe('FlashLimiter', () => {
  it('lets through at most three large rises per second', () => {
    const limiter = new FlashLimiter(1);
    const levels: number[] = [];
    // A 10 Hz full-brightness strobe for two seconds.
    for (let t = 0; t < 2000; t += 20) {
      const on = Math.floor(t / 50) % 2 === 0 ? 1 : 0;
      const rgb = Float32Array.of(on, on, on);
      limiter.apply(t, rgb);
      levels.push(rgb[0]);
    }
    for (let start = 0; start + 50 <= levels.length; start += 5) {
      expect(countRises(levels.slice(start, start + 50), 0.26)).toBeLessThanOrEqual(3);
    }
    expect(countRises(levels, 0.26)).toBeGreaterThanOrEqual(5);
  });

  it('leaves small changes alone', () => {
    const limiter = new FlashLimiter(1);
    for (let t = 0; t < 1000; t += 20) {
      const v = 0.4 + 0.2 * (Math.floor(t / 40) % 2);
      const rgb = Float32Array.of(v, v, v);
      limiter.apply(t, rgb);
      expect(rgb[0]).toBeCloseTo(v);
    }
  });
});
