// Render engine: two built-in spatial looks (Pulse, Wave), the master controls, group
// faders and the photosensitivity limiter. Pure TypeScript with no I/O, so it runs in the
// server's engine worker and later in the browser for previews. Same inputs, same output.

export type AudioSignals = {
  /** Loudness, 0..1 after gain control. */
  level: number;
  /** Bass energy (40–320 Hz), 0..1 after gain control. */
  bass: number;
};

export type MasterControls = { brightness: number; intensity: number; blackout: boolean; look?: 'pulse' | 'wave' };

const BASS_ATTACK_MS = 15;
const BASS_RELEASE_MS = 220;
const FLASH_DECAY_MS = 140;
/** No audio for this long means ambient mode. */
const AUDIO_TIMEOUT_MS = 500;
/** Ambient ↔ reactive crossfade, so a mode change never jumps. */
const CROSSFADE_MS = 500;
/** The look itself never asks for more than 3 flashes a second. */
const MIN_FLASH_GAP_MS = 333;

/** h, s, v in 0..1 → RGB 0..1, written to out[offset..offset + 2]. */
export function hsvInto(h: number, s: number, v: number, out: Float32Array, offset: number): void {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r: number, g: number, b: number;
  switch (((i % 6) + 6) % 6) {
    case 0: [r, g, b] = [v, t, p]; break;
    case 1: [r, g, b] = [q, v, p]; break;
    case 2: [r, g, b] = [p, v, t]; break;
    case 3: [r, g, b] = [p, q, v]; break;
    case 4: [r, g, b] = [t, p, v]; break;
    default: [r, g, b] = [v, p, q];
  }
  out[offset] = r;
  out[offset + 1] = g;
  out[offset + 2] = b;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The last stage before the lights (architecture §5.6): at most `maxPerSecond` large
 * brightness rises per channel in any second (WCAG 2.3.1: three flashes). A rise larger
 * than `threshold` beyond that budget is cut down to `threshold`.
 */
export class FlashLimiter {
  private readonly maxPerSecond: number;
  private readonly threshold: number;
  private readonly ref: Float64Array;
  private readonly rising: Uint8Array;
  private readonly rises: number[][];

  constructor(channels: number, opts: { maxPerSecond?: number; threshold?: number } = {}) {
    this.maxPerSecond = opts.maxPerSecond ?? 3;
    this.threshold = opts.threshold ?? 0.25;
    this.ref = new Float64Array(channels);
    this.rising = new Uint8Array(channels);
    this.rises = Array.from({ length: channels }, () => []);
  }

  apply(t: number, rgb: Float32Array): void {
    for (let i = 0; i < this.ref.length; i++) {
      const o = i * 3;
      const level = Math.max(rgb[o], rgb[o + 1], rgb[o + 2]);
      const rises = this.rises[i];
      while (rises.length && t - rises[0] >= 1000) rises.shift();
      if (this.rising[i]) {
        // Follow the peak up; a clear drop ends the rise.
        if (level >= this.ref[i]) this.ref[i] = level;
        else if (level < this.ref[i] - 0.05) [this.rising[i], this.ref[i]] = [0, level];
      } else if (level <= this.ref[i]) {
        this.ref[i] = level; // follow the trough down
      } else if (level - this.ref[i] > this.threshold) {
        if (rises.length < this.maxPerSecond) {
          rises.push(t);
          [this.rising[i], this.ref[i]] = [1, level];
        } else {
          const k = (this.ref[i] + this.threshold) / level;
          rgb[o] *= k;
          rgb[o + 1] *= k;
          rgb[o + 2] *= k;
        }
      }
    }
  }
}

/** A channel's position seen from the listener, Hue's −1..1 space: x right, y front, z up. */
export type Position = { x: number; y: number; z: number };

/** Wave: how long a kick takes to ripple from the listener to the farthest light. */
const WAVE_MS = 260;

const flashAt = (age: number) => (age < 0 ? 0 : Math.exp(-age / FLASH_DECAY_MS));

/**
 * Two looks share the signals. Pulse: hues drift across the room, brightness follows the
 * bass and every light flashes on a kick, shifting the hue. Wave: the same, but a kick
 * ripples outward from the listener. Without audio both breathe slowly instead.
 */
export class Engine {
  readonly channels: number;
  /** The last rendered frame: r, g, b (0..1) per channel. */
  readonly rgb: Float32Array;
  private readonly limiter: FlashLimiter;
  private readonly pos: Position[];
  /** Distance from the listener, 0..1. */
  private readonly dist: Float32Array;
  /** Per-channel fader (group levels), 0..1. */
  private readonly gains: Float32Array;
  private lastT: number | undefined;
  private lastAudioT = Number.NEGATIVE_INFINITY;
  private lastFlashT = Number.NEGATIVE_INFINITY;
  /** The kick before, still rippling outward in Wave. */
  private prevFlashT = Number.NEGATIVE_INFINITY;
  private bass = 0;
  private bassEnv = 0;
  private hueShift = 0;
  private audioMix = 0;

  /** A channel count (lights in a line, left to right) or each channel's position. */
  constructor(layout: number | Position[]) {
    this.pos =
      typeof layout === 'number'
        ? Array.from({ length: layout }, (_, i) => ({ x: layout === 1 ? 0 : -1 + (2 * i) / (layout - 1), y: 0.8, z: 0 }))
        : layout;
    this.channels = this.pos.length;
    this.rgb = new Float32Array(this.channels * 3);
    this.limiter = new FlashLimiter(this.channels);
    this.dist = Float32Array.from(this.pos, (p) => Math.min(1, Math.hypot(p.x, p.y, p.z) / Math.sqrt(3)));
    this.gains = new Float32Array(this.channels).fill(1);
  }

  /** Per-channel levels (group faders), in channel order. */
  setGains(gains: ArrayLike<number>): void {
    for (let i = 0; i < this.channels; i++) this.gains[i] = clamp01(gains[i] ?? 1);
  }

  /** Live audio, already delayed to line up with the speaker. */
  audio(t: number, signals: AudioSignals): void {
    this.lastAudioT = t;
    this.bass = clamp01(signals.bass);
  }

  /** A detected kick. */
  onset(t: number): void {
    if (t - this.lastFlashT < MIN_FLASH_GAP_MS) return;
    this.prevFlashT = this.lastFlashT;
    this.lastFlashT = t;
    this.hueShift = (this.hueShift + 0.13) % 1;
  }

  /** Renders time t (ms). Allocates nothing. */
  render(t: number, master: MasterControls): Float32Array {
    const dt = this.lastT === undefined ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    const live = t - this.lastAudioT < AUDIO_TIMEOUT_MS;
    if (!live) this.bass = 0;
    this.audioMix = clamp01(this.audioMix + ((live ? 1 : -1) * dt) / CROSSFADE_MS);
    const attack = this.bass > this.bassEnv ? BASS_ATTACK_MS : BASS_RELEASE_MS;
    this.bassEnv += (this.bass - this.bassEnv) * (1 - Math.exp(-dt / attack));

    const depth = clamp01(master.intensity);
    const gain = master.blackout ? 0 : clamp01(master.brightness);
    const bassReact = 0.8 * this.bassEnv ** 1.5;
    for (let i = 0; i < this.channels; i++) {
      const { x, y } = this.pos[i];
      const delay = master.look === 'wave' ? this.dist[i] * WAVE_MS : 0;
      const flash = Math.max(flashAt(t - this.lastFlashT - delay), flashAt(t - this.prevFlashT - delay));
      const react = 0.12 + 0.88 * Math.max(bassReact, flash);
      const hue = (((t / 60_000 + this.hueShift + 0.2 * (x + 1) + 0.05 * (y + 1)) % 1) + 1) % 1;
      const ambient = 0.3 + 0.12 * Math.sin((2 * Math.PI * t) / 7000 + 2.6 * (x + 1) + 1.2 * (y + 1));
      const v = lerp(ambient, lerp(ambient, react, depth), this.audioMix);
      const s = 0.9 - 0.4 * flash * depth * this.audioMix;
      hsvInto(hue, s, v * gain * this.gains[i], this.rgb, i * 3);
    }
    this.limiter.apply(t, this.rgb);
    return this.rgb;
  }
}
