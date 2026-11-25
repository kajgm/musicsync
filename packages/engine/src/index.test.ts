import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, Engine, FlashLimiter, type Program } from './index.ts';

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

  /** Peak time per channel around a kick at 500 ms. */
  const peakTimes = (engine: Engine, setup?: (e: Engine) => void) => {
    setup?.(engine);
    const best = Array.from({ length: engine.channels }, () => ({ t: 0, v: 0 }));
    for (let t = 0; t < 1200; t += 10) {
      engine.audio(t, { level: 0.2, bass: 0 });
      if (t === 500) engine.onset(t);
      const rgb = engine.render(t, master);
      best.forEach((b, ch) => peak(rgb, ch) > b.v && Object.assign(b, { t, v: peak(rgb, ch) }));
    }
    return best.map((b) => b.t);
  };
  const flashOnly = (channels: number[], params = {}, profiles: Program['profiles'] = []): Program => ({
    key: 'test',
    palette: [[0.7, 0.1, 0]],
    profiles,
    layers: [{ effect: 'flash', channels, blend: 'normal', opacity: 1, params }],
  });

  it('ripples a kick outward with the flash ripple, and all at once without', () => {
    const near = { x: 0.1, y: 0.1, z: 0 };
    const far = { x: 1, y: 1, z: 1 };
    const [pNear, pFar] = peakTimes(new Engine([near, far]), (e) => e.setProgram(flashOnly([0, 1])));
    expect(pFar).toBe(pNear);
    const [wNear, wFar] = peakTimes(new Engine([near, far]), (e) => e.setProgram(flashOnly([0, 1], { rippleMs: 260 })));
    expect(wFar - wNear).toBeGreaterThanOrEqual(200);
  });

  it('delays one light by its latency trim and leaves the others alone', () => {
    const profiles = [DEFAULT_PROFILE, { ...DEFAULT_PROFILE, latencyMs: 100 }];
    const [a, b] = peakTimes(new Engine(2), (e) => e.setProgram(flashOnly([0, 1], {}, profiles)));
    expect(b - a).toBe(100);
  });

  it('tunes one light’s response without touching the others', () => {
    const program = (profiles: Program['profiles']): Program => ({
      key: 'test',
      palette: [[0.7, 0.1, 0]],
      profiles,
      layers: [{ effect: 'solid', channels: [0, 1], blend: 'normal', opacity: 1, params: { brightness: { bind: 'audio.bass', range: [0, 1], curve: 'linear', attackMs: 0, releaseMs: 0 } } }],
    });
    const swing = (profiles: Program['profiles']) => {
      const engine = new Engine(2);
      engine.setProgram(program(profiles));
      const lo: number[] = [];
      const hi: number[] = [];
      for (let t = 0; t < 2000; t += 20) {
        engine.audio(t, { level: 0.5, bass: Math.floor(t / 200) % 2 });
        const rgb = engine.render(t, master);
        if (t > 1000) [0, 1].forEach((ch) => ((Math.floor(t / 200) % 2 ? hi : lo)[ch] = peak(rgb, ch)));
      }
      return [hi[0] - lo[0], hi[1] - lo[1]];
    };
    const [a0, b0] = swing([]);
    const [a1, b1] = swing([DEFAULT_PROFILE, { ...DEFAULT_PROFILE, sensitivity: 0 }]);
    expect(a1).toBeCloseTo(a0, 5); // light 0 unchanged
    expect(b0).toBeGreaterThan(0.3);
    expect(b1).toBeLessThan(0.05); // light 1 no longer follows the bass
  });

  it('keeps a light without strobing from jumping', () => {
    const engine = new Engine(1);
    engine.setProgram(flashOnly([0], { decayMs: 50 }, [{ ...DEFAULT_PROFILE, strobe: false }]));
    const levels: number[] = [];
    for (let t = 0; t < 3000; t += 20) {
      engine.audio(t, { level: 1, bass: 1 });
      if (t % 400 === 0) engine.onset(t);
      levels.push(peak(engine.render(t, master)));
    }
    expect(countRises(levels, 0.26)).toBe(0);
  });

  it('crossfades to a new program instead of jumping', () => {
    const engine = new Engine(1);
    const solid = (key: string, brightness: number): Program => ({ key, palette: [[0.7, 0, 0]], profiles: [], layers: [{ effect: 'solid', channels: [0], blend: 'normal', opacity: 1, params: { brightness } }] });
    engine.setProgram(solid('a', 0.1));
    for (let t = 0; t <= 1000; t += 20) engine.render(t, master);
    engine.setProgram(solid('b', 0.9));
    const levels: number[] = [];
    for (let t = 1020; t <= 1700; t += 20) levels.push(peak(engine.render(t, master)));
    expect(levels[0]).toBeLessThan(0.2);
    expect(levels.at(-1)).toBeGreaterThan(0.5);
    for (let i = 1; i < levels.length; i++) expect(Math.abs(levels[i] - levels[i - 1])).toBeLessThan(0.1);
  });

  describe('beats', () => {
    const clock = { periodMs: 500, anchorT: 0, beatsPerBar: 4, soft: false };
    const flashOn = (on: string): Program => ({
      key: on,
      palette: [[0.7, 0.1, 0]],
      profiles: [],
      layers: [{ effect: 'flash', channels: [0], blend: 'normal', opacity: 1, params: { on, decayMs: 60 } }],
    });
    /** Times (ms) at which the light rises sharply. */
    const hits = (engine: Engine, from: number, to: number, audio?: (t: number) => void) => {
      const out: number[] = [];
      let prev = 0;
      for (let t = from; t < to; t += 10) {
        audio?.(t);
        const v = peak(engine.render(t, master));
        if (v - prev > 0.3) out.push(t);
        prev = v;
      }
      return out;
    };

    it('keeps flashing on the beat through a quiet passage', () => {
      const engine = new Engine(1);
      engine.setProgram(flashOn('beat'));
      engine.setBeats(clock);
      // Live audio that goes silent (level 0, no kicks) for the second half.
      const times = hits(engine, 0, 4000, (t) => engine.audio(t, { level: t < 2000 ? 0.8 : 0, bass: t < 2000 ? 0.8 : 0 }));
      expect(times.filter((t) => t >= 2000)).toEqual([2000, 2500, 3000, 3500]);
    });

    it('fires bar triggers every fourth beat', () => {
      const engine = new Engine(1);
      engine.setProgram(flashOn('bar'));
      engine.setBeats(clock);
      expect(hits(engine, 10, 4010)).toEqual([2000, 4000]);
    });

    it('turns beats into kicks when there is no live audio (phone playback)', () => {
      const engine = new Engine(1);
      engine.setProgram(flashOn('kick'));
      engine.setBeats(clock);
      // Once the 500 ms fade-in from idle is done, every beat is a kick.
      expect(hits(engine, 0, 3000)).toEqual([500, 1000, 1500, 2000, 2500]);
      // Softened: the rise starts at the beat but peaks later.
      const engine2 = new Engine(1);
      engine2.setProgram(flashOn('beat'));
      engine2.setBeats({ ...clock, soft: true });
      const levels: number[] = [];
      for (let t = 1000; t <= 1100; t += 10) levels.push(peak(engine2.render(t, master)));
      expect(levels.indexOf(Math.max(...levels))).toBeGreaterThanOrEqual(5);
    });

    it('stops beat effects when the clock is cleared', () => {
      const engine = new Engine(1);
      engine.setProgram(flashOn('beat'));
      engine.setBeats(clock);
      engine.setBeats(undefined);
      expect(hits(engine, 0, 2000)).toEqual([]);
    });
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
