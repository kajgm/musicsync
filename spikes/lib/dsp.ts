// Phase 0 prototype of packages/audio-features: FFT bands, spectral-flux onsets, tempo.

export type Frame = {
  /** performance.now() time of the frame's last sample, in ms. */
  t: number;
  rms: number;
  /** Energy per band in dB, BAND_EDGES_HZ[i] to BAND_EDGES_HZ[i + 1]. */
  bands: Float32Array;
  /** Positive spectral change across all bins (onset strength). */
  flux: number;
  /** The same below LOW_CUTOFF_HZ: kick drums and bass. */
  lowFlux: number;
};

export type Onset = { t: number; strength: number };

export const BAND_EDGES_HZ = [40, 80, 160, 320, 640, 1280, 2560, 5120, 16000];
const LOW_CUTOFF_HZ = 200;

/** In-place iterative radix-2 FFT. Lengths must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const halfLen = len >> 1;
    for (let start = 0; start < n; start += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < halfLen; k++) {
        const a = start + k;
        const b = a + halfLen;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** Sliding-window spectral analysis: one Frame per hop (512 samples ≈ 10.7 ms at 48 kHz). */
export class Analyzer {
  readonly sampleRate: number;
  readonly size: number;
  readonly hop: number;
  readonly hopMs: number;
  private readonly ring: Float32Array;
  private readonly win: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly prevLog: Float64Array;
  private readonly bandOf: Int8Array;
  private readonly bandBins: Uint16Array;
  private readonly lowBin: number;
  private readonly norm: number;
  private write = 0;
  private filled = 0;
  private sinceHop = 0;

  constructor(sampleRate: number, size = 2048, hop = 512) {
    this.sampleRate = sampleRate;
    this.size = size;
    this.hop = hop;
    this.hopMs = (hop / sampleRate) * 1000;
    this.ring = new Float32Array(size);
    this.win = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.prevLog = new Float64Array(size / 2);
    this.norm = 2 / this.win.reduce((sum, w) => sum + w, 0); // a windowed full-scale sine reads 1.0
    const binHz = sampleRate / size;
    this.lowBin = Math.floor(LOW_CUTOFF_HZ / binHz);
    this.bandOf = new Int8Array(size / 2).fill(-1);
    this.bandBins = new Uint16Array(BAND_EDGES_HZ.length - 1);
    for (let k = 1; k < size / 2; k++) {
      const hz = k * binHz;
      for (let b = 0; b < BAND_EDGES_HZ.length - 1; b++) {
        if (hz >= BAND_EDGES_HZ[b] && hz < BAND_EDGES_HZ[b + 1]) {
          this.bandOf[k] = b;
          this.bandBins[b] += 1;
          break;
        }
      }
    }
  }

  /** Feed a block whose last sample was captured at tLast (ms). Calls onFrame once per hop. */
  push(samples: Float32Array, tLast: number, onFrame: (frame: Frame) => void): void {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.write] = samples[i];
      this.write = (this.write + 1) % this.size;
      if (this.filled < this.size) this.filled++;
      if (++this.sinceHop >= this.hop && this.filled === this.size) {
        this.sinceHop = 0;
        onFrame(this.analyze(tLast - ((samples.length - 1 - i) * 1000) / this.sampleRate));
      }
    }
  }

  private analyze(t: number): Frame {
    const { size, ring, win, re, im, prevLog, bandOf, norm } = this;
    let sumSq = 0;
    for (let k = 0; k < size; k++) {
      const s = ring[(this.write + k) % size];
      sumSq += s * s;
      re[k] = s * win[k];
      im[k] = 0;
    }
    fft(re, im);
    const power = new Float64Array(this.bandBins.length);
    let flux = 0;
    let lowFlux = 0;
    for (let k = 1; k < size / 2; k++) {
      const mag = Math.hypot(re[k], im[k]) * norm;
      const log = Math.log1p(100 * mag);
      const rise = log - prevLog[k];
      prevLog[k] = log;
      if (rise > 0) {
        flux += rise;
        if (k <= this.lowBin) lowFlux += rise;
      }
      const b = bandOf[k];
      if (b >= 0) power[b] += mag * mag;
    }
    const bands = new Float32Array(power.length);
    for (let b = 0; b < power.length; b++) bands[b] = 10 * Math.log10(power[b] / this.bandBins[b] + 1e-12);
    return { t, rms: Math.sqrt(sumSq / size), bands, flux, lowFlux };
  }
}

/** Peak-picks an onset-strength signal against a running mean + k·sd threshold. */
export class OnsetPicker {
  private readonly windowFrames: number;
  private readonly k: number;
  private readonly floor: number;
  private readonly minGapMs: number;
  private readonly history: number[] = [];
  private prev = 0;
  private prevPrev = 0;
  private prevT = 0;
  private lastOnsetT = Number.NEGATIVE_INFINITY;

  constructor(opts: { windowFrames?: number; k?: number; floor?: number; minGapMs?: number } = {}) {
    this.windowFrames = opts.windowFrames ?? 43; // ≈ 0.5 s of frames
    this.k = opts.k ?? 1.5;
    this.floor = opts.floor ?? 1;
    this.minGapMs = opts.minGapMs ?? 120;
  }

  /** Feed one value per frame. An onset is reported one frame late (one frame of lookahead). */
  push(value: number, t: number): Onset | undefined {
    const h = this.history;
    let onset: Onset | undefined;
    if (h.length > 8) {
      const past = h.slice(0, -1); // exclude the candidate itself
      const mean = past.reduce((a, b) => a + b, 0) / past.length;
      const sd = Math.sqrt(past.reduce((a, b) => a + (b - mean) ** 2, 0) / past.length);
      const threshold = Math.max(this.floor, mean + this.k * sd);
      const isPeak = this.prev > this.prevPrev && this.prev >= value;
      if (isPeak && this.prev > threshold && this.prevT - this.lastOnsetT >= this.minGapMs) {
        onset = { t: this.prevT, strength: this.prev };
        this.lastOnsetT = this.prevT;
      }
    }
    h.push(value);
    if (h.length > this.windowFrames) h.shift();
    this.prevPrev = this.prev;
    this.prev = value;
    this.prevT = t;
    return onset;
  }
}

/** Tempo from the autocorrelation of an onset-strength envelope (60–200 BPM, biased toward 120). */
export class TempoTracker {
  private readonly hopMs: number;
  private readonly maxLen: number;
  private readonly env: number[] = [];

  constructor(hopMs: number, seconds = 8) {
    this.hopMs = hopMs;
    this.maxLen = Math.round((seconds * 1000) / hopMs);
  }

  push(value: number): void {
    this.env.push(value);
    if (this.env.length > this.maxLen) this.env.shift();
  }

  estimate(): { bpm: number; confidence: number } | undefined {
    const n = this.env.length;
    if (n < this.maxLen / 2) return undefined;
    const mean = this.env.reduce((a, b) => a + b, 0) / n;
    const x = this.env.map((v) => v - mean);
    const r0 = x.reduce((a, v) => a + v * v, 0) / n;
    if (r0 <= 1e-9) return undefined;
    const lagFor = (bpm: number) => 60000 / bpm / this.hopMs;
    const minLag = Math.floor(lagFor(200));
    const maxLag = Math.ceil(lagFor(60));
    const r = new Float64Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let sum = 0;
      for (let i = lag; i < n; i++) sum += x[i] * x[i - lag];
      r[lag] = sum / (n - lag);
    }
    let best = minLag;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = 60000 / (lag * this.hopMs);
      const score = r[lag] * Math.exp(-0.5 * Math.log2(bpm / 120) ** 2); // octave-wide prior
      if (score > bestScore) {
        bestScore = score;
        best = lag;
      }
    }
    const [a, b, c] = [r[best - 1], r[best], r[best + 1]];
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    return { bpm: 60000 / ((best + shift) * this.hopMs), confidence: Math.max(0, b / r0) };
  }
}
