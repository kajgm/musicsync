// Render engine (architecture §4.3, §5.1, §7): runs a program (a compiled look: layers of
// effects on selections of lights, parameters bound to signals, a palette and a response
// profile per light), crossfades between programs, applies the master controls and group
// faders, and ends in the photosensitivity limiter. Pure TypeScript with no I/O.
// Same inputs, same output. Rendering a frame allocates nothing.
import { oklchToOklab, type Oklab, type Oklch } from './color.ts';
import { AXIS_KEYS, Palette, decay, type Axis, type EffectContext, type EffectDef } from './effect.ts';
import { EFFECTS } from './effects/index.ts';

export * from './color.ts';
export * from './effect.ts';
export { EFFECTS } from './effects/index.ts';

export type AudioSignals = {
  /** Loudness, 0..1 after gain control. */
  level: number;
  /** Band energies (bass 40–320 Hz, mid 320–2560 Hz, high 2.5–16 kHz), 0..1 after gain control. */
  bass: number;
  mid?: number;
  high?: number;
};

export type MasterControls = { brightness: number; intensity: number; blackout: boolean };

/** A channel's position seen from the listener, Hue's −1..1 space: x right, y front, z up. */
export type Position = { x: number; y: number; z: number };

export const SIGNALS = {
  'audio.level': 'Loudness',
  'audio.bass': 'Bass',
  'audio.mid': 'Mids',
  'audio.high': 'Highs',
  'audio.band': 'The light’s own band',
  'audio.onset': 'Kick (fades)',
  'lfo.slow': 'Slow wave (8 s)',
  'lfo.fast': 'Fast wave (2 s)',
  'beat.pulse': 'Beat (pulse)',
  'beat.phase': 'Beat (ramp)',
  'bar.phase': 'Bar (ramp)',
} as const;
export type SignalName = keyof typeof SIGNALS;

export type Curve = 'linear' | 'exp' | 'log';
/** A number parameter that follows a signal: signal 0..1 → curve → range, smoothed. */
export type Binding = { bind: SignalName; range: [number, number]; curve: Curve; attackMs: number; releaseMs: number };
export type Blend = 'normal' | 'add' | 'max' | 'multiply' | 'screen';
export type Band = 'level' | 'bass' | 'mid' | 'high';

/** How one light responds (architecture §4.3). */
export type Profile = {
  /** Output brightness range: 0 maps to min, full to max. */
  min: number;
  max: number;
  /** > 1 darker mids and more punch; < 1 flatter. */
  gamma: number;
  /** Smoothing of the light's brightness. 0 = none. */
  attackMs: number;
  releaseMs: number;
  /** How strongly the audio moves this light: 0 = only the idle breathing, 1 = normal. */
  sensitivity: number;
  /** The band `audio.band` reads for this light. */
  band: Band;
  /** Delays this light behind the others. */
  latencyMs: number;
  /** false: no sudden jumps of more than 25 % (instead of at most 3 a second). */
  strobe: boolean;
};

export const DEFAULT_PROFILE: Profile = {
  min: 0,
  max: 1,
  gamma: 1,
  attackMs: 0,
  releaseMs: 0,
  sensitivity: 1,
  band: 'bass',
  latencyMs: 0,
  strobe: true,
};

export type ProgramLayer = {
  effect: string;
  /** Channel indexes this layer draws on. */
  channels: number[];
  blend: Blend;
  opacity: number;
  /** By parameter name: a number, an enum option key, or a binding. Missing = the default. */
  params: Record<string, number | string | Binding>;
  /** A show clip: drawn only from start to end of the track (ms), fading in and out. */
  window?: { startMs: number; endMs: number; fadeInMs: number; fadeOutMs: number };
  /** Number params following keyframes: [ms from the window start, value], sorted by time. */
  automation?: Record<string, Array<[number, number]>>;
};

/**
 * Where the beats fall, in engine time: from the track's beat grid and the playback clock,
 * or straight from the live beat tracker.
 */
export type BeatClock = {
  periodMs: number;
  /** Time of a downbeat (the first beat of a bar). */
  anchorT: number;
  beatsPerBar: number;
  /** Ramp hits in instead of jumping (phone playback, where the speaker delay is a guess). */
  soft: boolean;
};

/** The playing track's position: anchorPos (ms) at engine time anchorT, moving while playing. */
export type TrackClock = { anchorT: number; anchorPos: number; playing: boolean };

export type Program = {
  /** Same key = the same look edited (applied at once); a new key crossfades. */
  key: string;
  palette: Oklab[];
  layers: ProgramLayer[];
  /** Per channel; missing = the default profile. */
  profiles: Profile[];
};

const AUDIO_ATTACK_MS = 15;
const AUDIO_RELEASE_MS = 220;
/** No audio for this long means idle: the signals fall back to slow breathing. */
const AUDIO_TIMEOUT_MS = 500;
/** Live ↔ idle and program changes crossfade, so nothing jumps. */
const CROSSFADE_MS = 500;
/** Kicks closer together than this are one kick: never more than 3 flashes a second. */
const MIN_FLASH_GAP_MS = 333;
/** Signal history kept for per-light latency trims: 64 frames ≈ 1.3 s at 50 Hz. */
const HISTORY = 64;
const AUDIO_ONSET_MS = 140;
const BEAT_PULSE_MS = 180;
const SOFT_MS = 60;

const BLENDS: Blend[] = ['normal', 'add', 'max', 'multiply', 'screen'];
const SIGNAL_KEYS = Object.keys(SIGNALS) as SignalName[];
const BAND_INDEX: Record<Band, number> = { level: 0, bass: 1, mid: 2, high: 3 };

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** One-pole smoothing towards `target` with separate attack and release times. */
const follow = (cur: number, target: number, dt: number, attack: number, release: number) => {
  const tau = target > cur ? attack : release;
  return tau <= 0 ? target : cur + (target - cur) * (1 - Math.exp(-dt / tau));
};

/** Linear interpolation through keyframes (ms sorted); held flat before the first and after the last. */
function keyframeAt(ms: Float64Array, val: Float64Array, at: number): number {
  const n = ms.length;
  if (at <= ms[0]) return val[0];
  if (at >= ms[n - 1]) return val[n - 1];
  let i = 1;
  while (ms[i] < at) i++;
  const k = (at - ms[i - 1]) / (ms[i] - ms[i - 1] || 1);
  return val[i - 1] + (val[i] - val[i - 1]) * k;
}

/** The Pulse look's palette: six even hues. */
export const RAINBOW: Oklch[] = [20, 80, 150, 220, 280, 330].map((h) => ({ l: 0.72, c: 0.14, h }));

/** Used until the server sends a program: Pulse on every light. */
export function defaultProgram(channels: number): Program {
  const all = Array.from({ length: channels }, (_, i) => i);
  return {
    key: 'default',
    palette: RAINBOW.map(oklchToOklab),
    profiles: [],
    layers: [
      {
        effect: 'wash',
        channels: all,
        blend: 'normal',
        opacity: 1,
        params: { brightness: { bind: 'audio.bass', range: [0.12, 0.9], curve: 'linear', attackMs: 0, releaseMs: 0 } },
      },
      { effect: 'flash', channels: all, blend: 'screen', opacity: 1, params: { strength: 0.7 } },
    ],
  };
}

/**
 * The photosensitivity limiter, the last stage before the lights (architecture §5.6): at
 * most `maxPerSecond` large brightness rises per channel in any second (WCAG 2.3.1: three
 * flashes). A rise larger than `threshold` beyond that budget is cut down to `threshold`.
 */
export class FlashLimiter {
  private readonly max: Uint8Array;
  private readonly threshold: number;
  private readonly ref: Float64Array;
  private readonly rising: Uint8Array;
  private readonly rises: number[][];

  constructor(channels: number, opts: { maxPerSecond?: number; threshold?: number } = {}) {
    this.max = new Uint8Array(channels).fill(opts.maxPerSecond ?? 3);
    this.threshold = opts.threshold ?? 0.25;
    this.ref = new Float64Array(channels);
    this.rising = new Uint8Array(channels);
    this.rises = Array.from({ length: channels }, () => []);
  }

  /** Large rises allowed per second for one channel (0 = never). Capped at 3. */
  setMax(channel: number, perSecond: number): void {
    if (channel < this.max.length) this.max[channel] = Math.min(3, Math.max(0, perSecond));
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
        if (rises.length < this.max[i]) {
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

// ---- Compiled programs ----

type Layer = {
  def: EffectDef;
  channels: Int32Array;
  /** Per layer channel, 5 axis values (AXIS_KEYS order). */
  axes: Float32Array;
  blend: number;
  opacity: number;
  /** Values for unbound params; bound ones are filled in per channel. */
  stat: Float64Array;
  binds: Array<{ index: number; signal: number; lo: number; hi: number; curve: Curve; attackMs: number; releaseMs: number }>;
  /** Smoothed bound values: binds × channels. */
  env: Float64Array;
  window: ProgramLayer['window'];
  autos: Array<{ index: number; ms: Float64Array; val: Float64Array }>;
};

type Compiled = { key: string; palette: Palette; layers: Layer[]; lastT: number | undefined };

function compile(program: Program, pos: Position[], dist: Float32Array): Compiled {
  const n = pos.length;
  const layers: Layer[] = [];
  for (const spec of program.layers) {
    const def = EFFECTS[spec.effect];
    if (!def) continue;
    const channels = Int32Array.from(spec.channels.filter((c) => c >= 0 && c < n));
    if (channels.length === 0) continue;
    const names = Object.keys(def.params);
    const stat = new Float64Array(names.length);
    const binds: Layer['binds'] = [];
    const autos: Layer['autos'] = [];
    names.forEach((name, index) => {
      const ps = def.params[name];
      const v = spec.params[name];
      if (ps.kind === 'enum') {
        const keys = Object.keys(ps.options);
        const at = keys.indexOf(typeof v === 'string' ? v : ps.default);
        stat[index] = at >= 0 ? at : keys.indexOf(ps.default);
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        stat[index] = ps.kind === 'number' ? Math.min(ps.max, Math.max(ps.min, v)) : Math.round(v);
      } else if (ps.kind === 'number' && v && typeof v === 'object' && SIGNAL_KEYS.includes(v.bind)) {
        const clamp = (x: number) => Math.min(ps.max, Math.max(ps.min, x));
        binds.push({ index, signal: SIGNAL_KEYS.indexOf(v.bind), lo: clamp(v.range[0]), hi: clamp(v.range[1]), curve: v.curve, attackMs: v.attackMs, releaseMs: v.releaseMs });
        stat[index] = clamp(v.range[0]);
      } else {
        stat[index] = ps.default;
      }
      const keys = ps.kind === 'number' ? spec.automation?.[name] : undefined;
      if (ps.kind === 'number' && keys?.length) {
        const sorted = [...keys].sort((a, b) => a[0] - b[0]);
        autos.push({ index, ms: Float64Array.from(sorted, (k) => k[0]), val: Float64Array.from(sorted, (k) => Math.min(ps.max, Math.max(ps.min, k[1]))) });
      }
    });
    // Positions relative to this layer's lights: 0..1 along each axis.
    const span = (get: (p: Position) => number) => {
      const vals = Array.from(channels, (c) => get(pos[c]));
      const [lo, hi] = [Math.min(...vals), Math.max(...vals)];
      return vals.map((v) => (hi - lo < 1e-6 ? 0.5 : (v - lo) / (hi - lo)));
    };
    const xs = span((p) => p.x);
    const ys = span((p) => p.y);
    const zs = span((p) => p.z);
    const rank = Array.from(channels.keys()).sort((a, b) => pos[channels[a]].x - pos[channels[b]].x || channels[a] - channels[b]);
    const order = new Float32Array(channels.length);
    rank.forEach((j, r) => (order[j] = channels.length === 1 ? 0.5 : r / (channels.length - 1)));
    const axes = new Float32Array(channels.length * 5);
    for (let j = 0; j < channels.length; j++) {
      axes.set([xs[j], ys[j], zs[j], dist[channels[j]], order[j]], j * 5);
    }
    layers.push({
      def,
      channels,
      axes,
      blend: Math.max(0, BLENDS.indexOf(spec.blend)),
      opacity: clamp01(spec.opacity),
      stat,
      binds,
      env: new Float64Array(binds.length * channels.length),
      window: spec.window,
      autos,
    });
  }
  return { key: program.key, palette: new Palette(program.palette), layers, lastT: undefined };
}

export class Engine {
  readonly channels: number;
  /** The last rendered frame: r, g, b (sRGB-encoded 0..1) per channel. */
  readonly rgb: Float32Array;
  private readonly limiter: FlashLimiter;
  private readonly pos: Position[];
  /** Distance from the listener, 0..1. */
  private readonly dist: Float32Array;
  /** Phase of each channel's idle breathing, from its position. */
  private readonly idlePhase: Float32Array;
  /** Per-channel fader (group levels), 0..1. */
  private readonly gains: Float32Array;
  private profiles: Profile[];
  /** Per-channel brightness smoothing (profile attack/release). */
  private readonly lumEnv: Float64Array;
  private current: Compiled;
  private previous: Compiled | undefined;
  private fadeFrom = 0;
  private readonly bufA: Float32Array;
  private readonly bufB: Float32Array;
  private readonly tmp = new Float32Array(3);
  private readonly p = new Float64Array(16);
  private readonly ctx: EffectContext;

  // Live audio: latest input, smoothed values, kicks.
  private readonly input = new Float64Array(4); // level, bass, mid, high
  private readonly smooth = new Float64Array(4);
  private lastT: number | undefined;
  private lastAudioT = Number.NEGATIVE_INFINITY;
  private beats: BeatClock | undefined;
  private track: TrackClock | undefined;
  /** The last beat that produced a stand-in kick. */
  private standInBeat = Number.NEGATIVE_INFINITY;
  private lastFlashT = Number.NEGATIVE_INFINITY;
  private prevFlashT = Number.NEGATIVE_INFINITY;
  private onsets = 0;
  private audioMix = 0;
  private intensity = 1;

  // Signal history (ring buffer), so a light with a latency trim sees the past.
  private readonly hT = new Float64Array(HISTORY).fill(Number.NEGATIVE_INFINITY);
  private readonly hAudio = new Float64Array(HISTORY * 4);
  private readonly hOnset = new Float64Array(HISTORY * 3); // onsetT, prevOnsetT, count
  private readonly hMix = new Float64Array(HISTORY);
  private head = -1;

  /** A channel count (lights in a line, left to right) or each channel's position. */
  constructor(layout: number | Position[]) {
    this.pos =
      typeof layout === 'number'
        ? Array.from({ length: layout }, (_, i) => ({ x: layout === 1 ? 0 : -1 + (2 * i) / (layout - 1), y: 0.8, z: 0 }))
        : layout;
    const n = (this.channels = this.pos.length);
    this.rgb = new Float32Array(n * 3);
    this.bufA = new Float32Array(n * 3);
    this.bufB = new Float32Array(n * 3);
    this.limiter = new FlashLimiter(n);
    this.dist = Float32Array.from(this.pos, (p) => Math.min(1, Math.hypot(p.x, p.y, p.z) / Math.sqrt(3)));
    this.idlePhase = Float32Array.from(this.pos, (p) => 2.6 * (p.x + 1) + 1.2 * (p.y + 1));
    this.gains = new Float32Array(n).fill(1);
    this.lumEnv = new Float64Array(n);
    this.profiles = [];
    this.current = compile(defaultProgram(n), this.pos, this.dist);
    const axis = {} as Record<Axis, number>;
    for (const k of AXIS_KEYS) axis[k] = 0;
    this.ctx = {
      t: 0,
      axis,
      trigT: new Float64Array(3),
      trigPrev: new Float64Array(3),
      trigCount: new Float64Array(3),
      trigReact: new Float64Array(3),
      softMs: 0,
      channel: 0,
      palette: this.current.palette,
    };
  }

  /** The playing track's position (for show clips), or undefined with no track. */
  setTrack(clock: TrackClock | undefined): void {
    this.track = clock;
  }

  /** Where the beats fall, or undefined when there's no beat to follow. */
  setBeats(clock: BeatClock | undefined): void {
    this.beats = clock && clock.periodMs > 0 ? clock : undefined;
  }

  /** Beat number at time t (beat 0 is the anchor), or NaN without a beat clock. */
  private beatAt(t: number): number {
    const b = this.beats;
    return b ? Math.floor((t - b.anchorT) / b.periodMs) : Number.NaN;
  }

  /** Runs a program. Same key: applied at once (a live edit). New key: crossfades. */
  setProgram(program: Program): void {
    const next = compile(program, this.pos, this.dist);
    if (program.key !== this.current.key) {
      this.previous = this.current;
      this.fadeFrom = this.lastT ?? 0;
    } else {
      // Keep the smoothing state where the layers still line up.
      next.lastT = this.current.lastT;
      next.layers.forEach((l, i) => {
        const old = this.current.layers[i];
        if (old && old.env.length === l.env.length) l.env.set(old.env);
      });
    }
    this.current = next;
    this.profiles = program.profiles;
    for (let c = 0; c < this.channels; c++) this.limiter.setMax(c, this.profile(c).strobe ? 3 : 0);
  }

  /** Per-channel levels (group faders), in channel order. */
  setGains(gains: ArrayLike<number>): void {
    for (let i = 0; i < this.channels; i++) this.gains[i] = clamp01(gains[i] ?? 1);
  }

  /** Live audio, already delayed to line up with the speaker. */
  audio(t: number, signals: AudioSignals): void {
    this.lastAudioT = t;
    this.input[0] = clamp01(signals.level);
    this.input[1] = clamp01(signals.bass);
    this.input[2] = clamp01(signals.mid ?? signals.level);
    this.input[3] = clamp01(signals.high ?? signals.level);
  }

  /** A detected kick. */
  onset(t: number): void {
    if (t - this.lastFlashT < MIN_FLASH_GAP_MS) return;
    this.prevFlashT = this.lastFlashT;
    this.lastFlashT = t;
    this.onsets++;
  }

  private profile(c: number): Profile {
    return this.profiles[c] ?? DEFAULT_PROFILE;
  }

  /** Renders time t (ms). */
  render(t: number, master: MasterControls): Float32Array {
    const dt = this.lastT === undefined ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    let live = t - this.lastAudioT < AUDIO_TIMEOUT_MS;
    if (!live && this.beats) {
      // No live audio but a beat to follow (phone playback): beats stand in for kicks and bass.
      live = true;
      const n = this.beatAt(t);
      const beatT = this.beats.anchorT + n * this.beats.periodMs;
      if (n !== this.standInBeat) {
        this.standInBeat = n;
        this.onset(beatT);
      }
      const pulse = decay(t - beatT, BEAT_PULSE_MS);
      this.input[0] = 0.55;
      this.input[1] = 0.3 + 0.7 * pulse;
      this.input[2] = 0.45 + 0.25 * pulse;
      this.input[3] = 0.45;
    } else if (!live) {
      this.input.fill(0);
    }
    this.audioMix = clamp01(this.audioMix + ((live ? 1 : -1) * dt) / CROSSFADE_MS);
    for (let b = 0; b < 4; b++) this.smooth[b] = follow(this.smooth[b], this.input[b], dt, AUDIO_ATTACK_MS, AUDIO_RELEASE_MS);
    this.intensity = clamp01(master.intensity);
    this.record(t);

    this.renderProgram(this.current, t, this.bufA);
    const fade = this.previous ? clamp01((t - this.fadeFrom) / CROSSFADE_MS) : 1;
    if (this.previous && fade < 1) {
      this.renderProgram(this.previous, t, this.bufB);
      for (let i = 0; i < this.bufA.length; i++) this.bufA[i] = lerp(this.bufB[i], this.bufA[i], fade);
    } else {
      this.previous = undefined;
    }

    const gain = master.blackout ? 0 : clamp01(master.brightness);
    for (let c = 0; c < this.channels; c++) {
      const o = c * 3;
      const pr = this.profile(c);
      const level = Math.max(this.bufA[o], this.bufA[o + 1], this.bufA[o + 2]);
      this.lumEnv[c] = follow(this.lumEnv[c], level, dt, pr.attackMs, pr.releaseMs);
      let k = 0;
      if (level > 1e-4) {
        const shaped = pr.min + (pr.max - pr.min) * clamp01(this.lumEnv[c]) ** pr.gamma;
        k = (shaped / level) * gain * this.gains[c];
      }
      this.rgb[o] = clamp01(this.bufA[o] * k);
      this.rgb[o + 1] = clamp01(this.bufA[o + 1] * k);
      this.rgb[o + 2] = clamp01(this.bufA[o + 2] * k);
    }
    this.limiter.apply(t, this.rgb);
    return this.rgb;
  }

  private record(t: number): void {
    const h = (this.head = (this.head + 1) % HISTORY);
    this.hT[h] = t;
    this.hAudio.set(this.smooth, h * 4);
    this.hOnset[h * 3] = this.lastFlashT;
    this.hOnset[h * 3 + 1] = this.prevFlashT;
    this.hOnset[h * 3 + 2] = this.onsets;
    this.hMix[h] = this.audioMix;
  }

  /** History slot as of `t − trim`: the newest frame no later than that. */
  private slot(t: number, trimMs: number): number {
    if (trimMs <= 0) return this.head;
    let h = this.head;
    for (let i = 0; i < HISTORY - 1; i++) {
      if (this.hT[h] <= t - trimMs) return h;
      const prev = (h - 1 + HISTORY) % HISTORY;
      if (this.hT[prev] === Number.NEGATIVE_INFINITY) return h;
      h = prev;
    }
    return h;
  }

  /** A signal's value for channel c, read from history slot h, 0..1. */
  private signal(signal: number, c: number, h: number, t: number): number {
    const pr = this.profile(c);
    const name = SIGNAL_KEYS[signal];
    if (name === 'lfo.slow') return 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 8000);
    if (name === 'lfo.fast') return 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 2000);
    const beats = this.beats;
    if (name === 'beat.phase' || name === 'bar.phase' || name === 'beat.pulse') {
      if (!beats) return 0;
      const x = (t - beats.anchorT) / beats.periodMs;
      if (name === 'beat.phase') return x - Math.floor(x);
      if (name === 'bar.phase') return x / beats.beatsPerBar - Math.floor(x / beats.beatsPerBar);
      return clamp01(decay((x - Math.floor(x)) * beats.periodMs, BEAT_PULSE_MS) * this.intensity * pr.sensitivity);
    }
    const react = this.intensity * this.hMix[h] * pr.sensitivity;
    if (name === 'audio.onset') {
      const on = Math.max(decay(t - this.hOnset[h * 3], AUDIO_ONSET_MS), decay(t - this.hOnset[h * 3 + 1], AUDIO_ONSET_MS));
      return clamp01(on * react);
    }
    const band = name === 'audio.band' ? BAND_INDEX[pr.band] : SIGNAL_KEYS.indexOf(name);
    // Idle (no audio, or intensity 0): a slow breathing that drifts across the room.
    const idle = 0.25 + 0.12 * Math.sin((2 * Math.PI * t) / 7000 + this.idlePhase[c]);
    return clamp01(idle + (this.hAudio[h * 4 + band] - idle) * react);
  }

  private renderProgram(prog: Compiled, t: number, out: Float32Array): void {
    const dt = prog.lastT === undefined ? 0 : Math.max(0, t - prog.lastT);
    prog.lastT = t;
    out.fill(0);
    const ctx = this.ctx;
    ctx.palette = prog.palette;
    const p = this.p;
    for (const layer of prog.layers) {
      const n = layer.channels.length;
      for (let j = 0; j < n; j++) {
        const c = layer.channels[j];
        const trim = this.profile(c).latencyMs;
        const h = this.slot(t, trim);
        ctx.t = t - trim;
        ctx.channel = c;
        // A show clip only draws inside its time window, fading in and out.
        let fade = 1;
        let rel = 0;
        const win = layer.window;
        if (win) {
          const track = this.track;
          if (!track) continue;
          const pos = track.playing ? track.anchorPos + ctx.t - track.anchorT : track.anchorPos;
          if (pos < win.startMs || pos >= win.endMs) continue;
          rel = pos - win.startMs;
          if (win.fadeInMs > 0) fade = Math.min(fade, rel / win.fadeInMs);
          if (win.fadeOutMs > 0) fade = Math.min(fade, (win.endMs - pos) / win.fadeOutMs);
        }
        const sens = Math.min(1, this.profile(c).sensitivity);
        ctx.trigT[0] = this.hOnset[h * 3];
        ctx.trigPrev[0] = this.hOnset[h * 3 + 1];
        ctx.trigCount[0] = this.hOnset[h * 3 + 2];
        ctx.trigReact[0] = this.intensity * this.hMix[h] * sens;
        const b = this.beats;
        if (b) {
          const n = this.beatAt(ctx.t);
          const bar = Math.floor(n / b.beatsPerBar);
          ctx.trigT[1] = b.anchorT + n * b.periodMs;
          ctx.trigPrev[1] = ctx.trigT[1] - b.periodMs;
          ctx.trigCount[1] = n;
          ctx.trigT[2] = b.anchorT + bar * b.beatsPerBar * b.periodMs;
          ctx.trigPrev[2] = ctx.trigT[2] - b.beatsPerBar * b.periodMs;
          ctx.trigCount[2] = bar;
          ctx.trigReact[1] = ctx.trigReact[2] = this.intensity * sens;
          ctx.softMs = b.soft ? SOFT_MS : 0;
        } else {
          ctx.trigT[1] = ctx.trigT[2] = ctx.trigPrev[1] = ctx.trigPrev[2] = Number.NEGATIVE_INFINITY;
          ctx.trigCount[1] = ctx.trigCount[2] = 0;
          ctx.trigReact[1] = ctx.trigReact[2] = 0;
          ctx.softMs = 0;
        }
        for (let a = 0; a < 5; a++) ctx.axis[AXIS_KEYS[a]] = layer.axes[j * 5 + a];
        p.set(layer.stat);
        for (let b = 0; b < layer.binds.length; b++) {
          const bind = layer.binds[b];
          const s = this.signal(bind.signal, c, h, ctx.t);
          const shaped = bind.curve === 'exp' ? s * s : bind.curve === 'log' ? Math.sqrt(s) : s;
          const target = bind.lo + (bind.hi - bind.lo) * shaped;
          const e = b * n + j;
          // The first frame starts at the target instead of rising from 0.
          layer.env[e] = dt === 0 ? target : follow(layer.env[e], target, dt, bind.attackMs, bind.releaseMs);
          p[bind.index] = layer.env[e];
        }
        for (const auto of layer.autos) p[auto.index] = keyframeAt(auto.ms, auto.val, rel);
        const tmp = this.tmp;
        layer.def.render(ctx, p, tmp, 0);
        const o = c * 3;
        const k = layer.opacity * fade;
        for (let i = 0; i < 3; i++) {
          const a = out[o + i];
          const v = tmp[i];
          let mixed: number;
          switch (layer.blend) {
            case 1: mixed = a + v; break; // add
            case 2: mixed = Math.max(a, v); break; // max
            case 3: mixed = a * v; break; // multiply
            case 4: mixed = 1 - (1 - a) * (1 - v); break; // screen
            default: mixed = v; // normal
          }
          out[o + i] = clamp01(lerp(a, mixed, k));
        }
      }
    }
  }
}
