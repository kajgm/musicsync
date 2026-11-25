// Tempo and beat phase from onset strength (architecture §5.3): the last few seconds of
// spectral flux on a 10 ms grid, autocorrelation (with a soft preference for ~120 BPM)
// for the period, and a comb filter for where the beats fall.

export type BeatEstimate = {
  /** Beat period in ms. */
  periodMs: number;
  /** A beat time (same clock as the input), the most recent one found. */
  anchorT: number;
  /** 0..1: how clearly periodic the recent audio is. */
  confidence: number;
};

const BIN_MS = 10;

export class BeatTracker {
  private readonly bins: Float64Array;
  private readonly minLag: number;
  private readonly maxLag: number;
  private readonly everyMs: number;
  private head = -1;
  /** Absolute bin number of `head`. */
  private headBin = Number.NaN;
  private filled = 0;
  private lastRun = Number.NEGATIVE_INFINITY;
  estimate: BeatEstimate | undefined;

  constructor(opts: { windowMs?: number; minBpm?: number; maxBpm?: number; everyMs?: number } = {}) {
    this.bins = new Float64Array(Math.round((opts.windowMs ?? 8000) / BIN_MS));
    this.minLag = Math.floor(60_000 / (opts.maxBpm ?? 180) / BIN_MS);
    this.maxLag = Math.ceil(60_000 / (opts.minBpm ?? 70) / BIN_MS);
    this.everyMs = opts.everyMs ?? 500;
  }

  /** One onset-strength value per audio frame. Returns a new estimate when one is made. */
  push(strength: number, t: number): BeatEstimate | undefined {
    const bin = Math.floor(t / BIN_MS);
    if (Number.isNaN(this.headBin) || bin - this.headBin > this.bins.length || bin < this.headBin - this.bins.length) {
      this.bins.fill(0);
      [this.head, this.headBin, this.filled] = [0, bin, 1];
    }
    while (this.headBin < bin) {
      this.head = (this.head + 1) % this.bins.length;
      this.bins[this.head] = 0;
      this.headBin++;
      this.filled = Math.min(this.bins.length, this.filled + 1);
    }
    const at = (this.head - (this.headBin - bin) + this.bins.length) % this.bins.length;
    this.bins[at] = Math.max(this.bins[at], strength);

    if (t - this.lastRun < this.everyMs || this.filled < this.bins.length / 2) return undefined;
    this.lastRun = t;
    const next = this.analyse();
    if (!next) return undefined;
    // Small tempo drifts are smoothed; a clear change replaces the estimate.
    const prev = this.estimate;
    if (prev && Math.abs(next.periodMs / prev.periodMs - 1) < 0.04) next.periodMs = prev.periodMs + 0.3 * (next.periodMs - prev.periodMs);
    this.estimate = next;
    return next;
  }

  private analyse(): BeatEstimate | undefined {
    const n = this.filled;
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) raw[i] = Math.log1p(this.bins[(this.head - (n - 1 - i) + this.bins.length * 2) % this.bins.length]);
    // Novelty: above a 400 ms moving average, so steady loudness doesn't count.
    const env = new Float64Array(n);
    const half = 20;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < Math.min(n, half); i++) [sum, count] = [sum + raw[i], count + 1];
    for (let i = 0; i < n; i++) {
      if (i + half < n) [sum, count] = [sum + raw[i + half], count + 1];
      if (i - half - 1 >= 0) [sum, count] = [sum - raw[i - half - 1], count - 1];
      env[i] = Math.max(0, raw[i] - sum / count);
    }
    let energy = 0;
    for (let i = 0; i < n; i++) energy += env[i] * env[i];
    if (energy / n < 1e-6) return undefined;

    const ac = (lag: number) => {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
      return s / (n - lag);
    };
    const r0 = energy / n;
    const scores: number[] = [];
    let best = this.minLag;
    let bestScore = -Infinity;
    for (let lag = this.minLag; lag <= this.maxLag; lag++) {
      const r = ac(lag);
      scores.push(r);
      const bpm = 60_000 / (lag * BIN_MS);
      const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
      if (r * prior > bestScore) [best, bestScore] = [lag, r * prior];
    }
    // Sub-bin period from the neighbours of the peak.
    const [a, b, c] = [ac(best - 1), ac(best), ac(best + 1)];
    const denom = a - 2 * b + c;
    const period = best + (denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0);
    const mean = scores.reduce((x, y) => x + y, 0) / scores.length;
    const confidence = Math.max(0, Math.min(1, (b - mean) / Math.max(1e-9, r0 - mean)));

    // Phase: the offset whose comb of beats back from the newest bin collects most onsets.
    const sample = (x: number) => {
      const i = Math.floor(x);
      if (i < 0 || i + 1 >= n) return i >= 0 && i < n ? env[i] : 0;
      return env[i] + (env[i + 1] - env[i]) * (x - i);
    };
    let phase = 0;
    let phaseScore = -1;
    for (let p = 0; p < period; p += 0.5) {
      let s = 0;
      for (let k = 0; k * period + p < n; k++) s += sample(n - 1 - p - k * period);
      if (s > phaseScore) [phase, phaseScore] = [p, s];
    }
    const newestT = this.headBin * BIN_MS;
    return { periodMs: period * BIN_MS, anchorT: newestT - phase * BIN_MS, confidence };
  }
}
