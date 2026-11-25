import { describe, expect, it } from 'vitest';
import { Agc, Analyzer, OnsetPicker, bassAmplitude } from './index.ts';

const SR = 44100;

/** A 120 BPM click track: a 60 Hz kick-like thump every 500 ms from t = 1 s. */
function clickTrack(seconds: number): { pcm: Float32Array; clicksMs: number[] } {
  const pcm = new Float32Array(seconds * SR);
  const clicksMs: number[] = [];
  for (let c = 1; c < seconds - 0.5; c += 0.5) {
    clicksMs.push(c * 1000);
    const start = Math.round(c * SR);
    for (let i = 0; i < 0.12 * SR; i++) {
      const t = i / SR;
      pcm[start + i] = 0.15 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t / 0.04);
    }
  }
  return { pcm, clicksMs };
}

describe('Analyzer + OnsetPicker', () => {
  it('finds every click of a click track within one analysis hop', () => {
    const { pcm, clicksMs } = clickTrack(8);
    const analyzer = new Analyzer(SR);
    const picker = new OnsetPicker();
    const onsets: number[] = [];
    const block = 448; // what WASAPI loopback delivers
    for (let i = 0; i < pcm.length; i += block) {
      const samples = pcm.subarray(i, i + block);
      const tLast = ((i + samples.length - 1) / SR) * 1000;
      analyzer.push(samples, tLast, (frame) => {
        const onset = picker.push(frame.lowFlux, frame.t);
        if (onset) onsets.push(onset.t);
      });
    }
    expect(onsets).toHaveLength(clicksMs.length);
    for (const [i, t] of onsets.entries()) {
      // The first hop that sees the click is up to one hop (11.6 ms) after it.
      expect(t - clicksMs[i]).toBeGreaterThanOrEqual(0);
      expect(t - clicksMs[i]).toBeLessThan(2 * analyzer.hopMs);
    }
  });

  it('reports a full-scale 100 Hz sine as about 0 dB bass', () => {
    const pcm = Float32Array.from({ length: 4096 }, (_, i) => Math.sin((2 * Math.PI * 100 * i) / SR));
    const analyzer = new Analyzer(SR);
    let bass = 0;
    analyzer.push(pcm, 0, (frame) => (bass = bassAmplitude(frame.bands)));
    expect(bass).toBeGreaterThan(0.1);
    expect(bass).toBeLessThan(1.5);
  });
});

describe('Agc', () => {
  it('normalizes to the recent peak and lets the peak decay', () => {
    const agc = new Agc({ halfLifeMs: 1000 });
    expect(agc.push(0.2, 0)).toBe(1);
    expect(agc.push(0.1, 10)).toBeCloseTo(0.5, 1);
    // After two half-lives the old peak counts for a quarter.
    expect(agc.push(0.05, 2010)).toBeCloseTo(1, 1);
  });

  it('keeps silence at zero', () => {
    const agc = new Agc();
    expect(agc.push(0, 0)).toBe(0);
    expect(agc.push(1e-6, 10)).toBeLessThan(0.01);
  });
});
