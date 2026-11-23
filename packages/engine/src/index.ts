// Render engine, Phase 1: one built-in reactive look ("Pulse"), the master controls and
// the photosensitivity limiter. Pure TypeScript with no I/O, so it runs in the server's
// engine worker and later in the browser for previews. Same inputs, same output.

export type AudioSignals = {
  /** Loudness, 0..1 after gain control. */
  level: number;
  /** Bass energy (40–320 Hz), 0..1 after gain control. */
  bass: number;
};

export type MasterControls = { brightness: number; intensity: number; blackout: boolean };

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

/**
 * Pulse: hues drift slowly around the room; brightness follows the bass and flashes on
 * kicks, shifting the hue each time. Without audio it breathes slowly instead.
 */
export class Engine {
  readonly channels: number;
  /** The last rendered frame: r, g, b (0..1) per channel. */
  readonly rgb: Float32Array;
  private readonly limiter: FlashLimiter;
  private lastT: number | undefined;
  private lastAudioT = Number.NEGATIVE_INFINITY;
  private lastFlashT = Number.NEGATIVE_INFINITY;
  private bass = 0;
  private bassEnv = 0;
  private flash = 0;
  private hueShift = 0;
  private audioMix = 0;

  constructor(channels: number) {
    this.channels = channels;
    this.rgb = new Float32Array(channels * 3);
    this.limiter = new FlashLimiter(channels);
  }

  /** Live audio, already delayed to line up with the speaker. */
  audio(t: number, signals: AudioSignals): void {
    this.lastAudioT = t;
    this.bass = clamp01(signals.bass);
  }

  /** A detected kick. */
  onset(t: number): void {
    if (t - this.lastFlashT < MIN_FLASH_GAP_MS) return;
    this.lastFlashT = t;
    this.flash = 1;
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
    this.flash *= Math.exp(-dt / FLASH_DECAY_MS);

    const depth = clamp01(master.intensity);
    const gain = master.blackout ? 0 : clamp01(master.brightness);
    const react = 0.12 + 0.88 * Math.max(0.8 * this.bassEnv ** 1.5, this.flash);
    for (let i = 0; i < this.channels; i++) {
      const hue = (t / 60_000 + this.hueShift + i * 0.07) % 1;
      const ambient = 0.3 + 0.12 * Math.sin((2 * Math.PI * t) / 7000 + i * 0.9);
      const v = lerp(ambient, lerp(ambient, react, depth), this.audioMix);
      const s = 0.9 - 0.4 * this.flash * depth * this.audioMix;
      hsvInto(hue, s, v * gain, this.rgb, i * 3);
    }
    this.limiter.apply(t, this.rgb);
    return this.rgb;
  }
}
