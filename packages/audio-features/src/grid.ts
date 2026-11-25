// Beat grids in track time (architecture §5.4): a tempo and where a downbeat falls, fitted
// from beats seen while the track played on the PC or from taps.

export type GridFit = {
  periodMs: number;
  /** A beat's position in the track, 0 ≤ offset < period. */
  offsetMs: number;
  /** 0..1: how well the observations agree. */
  confidence: number;
  /** How many observations (or taps) it rests on. */
  count: number;
};

/** A beat seen at a track position with the tempo the tracker had then. */
export type BeatObservation = { periodMs: number; posMs: number; weight: number };

const mod = (x: number, m: number) => ((x % m) + m) % m;

/** Weighted circular mean of positions modulo `period`: [mean, resultant length 0..1]. */
function circularMean(items: Array<{ posMs: number; weight: number }>, period: number): [number, number] {
  let [c, s, w] = [0, 0, 0];
  for (const it of items) {
    const a = (2 * Math.PI * mod(it.posMs, period)) / period;
    c += it.weight * Math.cos(a);
    s += it.weight * Math.sin(a);
    w += it.weight;
  }
  if (w === 0) return [0, 0];
  const angle = Math.atan2(s, c);
  return [mod((angle / (2 * Math.PI)) * period, period), Math.hypot(c, s) / w];
}

/** Fits a grid to observations; undefined with too few or too scattered ones. */
export function fitGrid(obs: BeatObservation[], minCount = 16): GridFit | undefined {
  if (obs.length < minCount) return undefined;
  const sorted = obs.map((o) => o.periodMs).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const close = obs.filter((o) => Math.abs(o.periodMs / median - 1) < 0.03);
  if (close.length < minCount) return undefined;
  const w = close.reduce((s, o) => s + o.weight, 0);
  const periodMs = close.reduce((s, o) => s + o.periodMs * o.weight, 0) / w;
  const [offsetMs, confidence] = circularMean(close, periodMs);
  return { periodMs, offsetMs, confidence, count: close.length };
}

/**
 * Combines a stored grid with a new fit. Same tempo (within 2 %): averaged by how much each
 * rests on, so a grid improves with every play. Otherwise the more trustworthy one wins.
 */
export function mergeGrid(old: GridFit | undefined, fresh: GridFit): GridFit {
  if (!old) return fresh;
  if (Math.abs(fresh.periodMs / old.periodMs - 1) >= 0.02) {
    return fresh.confidence * Math.min(fresh.count, 200) > old.confidence * Math.min(old.count, 200) ? fresh : old;
  }
  const wOld = Math.min(old.count, 400) * old.confidence;
  const wNew = fresh.count * fresh.confidence;
  const periodMs = (old.periodMs * wOld + fresh.periodMs * wNew) / (wOld + wNew || 1);
  const [offsetMs, agree] = circularMean([{ posMs: old.offsetMs, weight: wOld }, { posMs: fresh.offsetMs, weight: wNew }], periodMs);
  return { periodMs, offsetMs, confidence: Math.min(1, Math.max(old.confidence, fresh.confidence) * agree), count: old.count + fresh.count };
}

/** A grid from tapped track positions (at least 8 taps, roughly steady). */
export function gridFromTaps(posMs: number[]): GridFit | undefined {
  if (posMs.length < 8) return undefined;
  const taps = [...posMs].sort((a, b) => a - b);
  const gaps = taps.slice(1).map((t, i) => t - taps[i]).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median < 250 || median > 1500) return undefined; // 40–240 BPM
  // Beat number of each tap, then a least-squares line through (beat, position).
  const k = taps.map((t) => Math.round((t - taps[0]) / median));
  const n = taps.length;
  const mk = k.reduce((s, x) => s + x, 0) / n;
  const mt = taps.reduce((s, x) => s + x, 0) / n;
  let [sxy, sxx] = [0, 0];
  for (let i = 0; i < n; i++) [sxy, sxx] = [sxy + (k[i] - mk) * (taps[i] - mt), sxx + (k[i] - mk) ** 2];
  if (sxx === 0) return undefined;
  const periodMs = sxy / sxx;
  const intercept = mt - periodMs * mk;
  const residual = Math.sqrt(taps.reduce((s, t, i) => s + (t - (intercept + periodMs * k[i])) ** 2, 0) / n);
  return { periodMs, offsetMs: mod(intercept, periodMs), confidence: Math.max(0, 1 - residual / (periodMs / 4)), count: n };
}
