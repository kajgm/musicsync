// The effect contract (architecture §7). An effect renders one channel at a time from a
// shared context, its parameter values and the palette. Effects keep no state: everything
// follows from time and the onset history, so the same inputs give the same frame.
import { encodeSrgb, oklabToLinear, type Oklab } from './color.ts';

export type ParamSpec =
  | { kind: 'number'; label: string; min: number; max: number; default: number; step?: number; unit?: string }
  /** Stored as the option's key; the effect sees its index. */
  | { kind: 'enum'; label: string; options: Record<string, string>; default: string }
  /** A palette entry: 0, 1, … (wrapping), or −1 for white. */
  | { kind: 'color'; label: string; default: number };

export type Axis = 'x' | 'y' | 'z' | 'dist' | 'order';
export const AXES: Record<Axis, string> = {
  x: 'Left → right',
  y: 'Back → front',
  z: 'Low → high',
  dist: 'Near → far',
  order: 'One by one',
};

/** One context object, refilled per channel: no allocation while rendering. */
export type EffectContext = {
  /** Time this channel sees (ms): the frame time minus its latency trim. */
  t: number;
  /** Position within the layer's lights, 0..1 per axis (0.5 when all are level). */
  axis: Record<Axis, number>;
  /**
   * Per trigger (TRIGGER_KEYS order: kick, beat, bar): when the last two happened as this
   * channel sees them, and how many so far.
   */
  trigT: Float64Array;
  trigPrev: Float64Array;
  trigCount: Float64Array;
  /** Per trigger, how much a hit should show, 0..1 (intensity; for kicks also live audio). */
  trigReact: Float64Array;
  /** Hits ramp up over this long instead of jumping (softened timing on phone playback). */
  softMs: number;
  /** Index of the channel in the whole frame (for seeded randomness). */
  channel: number;
  palette: Palette;
};

export type EffectDef = {
  id: string;
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  /** Writes r, g, b (sRGB-encoded 0..1) into out[o..o + 2]. `p` holds the params in declaration order. */
  render(ctx: EffectContext, p: Float64Array, out: Float32Array, o: number): void;
};

export const defineEffect = (def: EffectDef): EffectDef => def;

const scratch = new Float32Array(3);

/** Palette colours in OKLab; sampled smoothly around the cycle, or by entry. */
export class Palette {
  readonly colors: Oklab[];
  constructor(colors: Oklab[]) {
    this.colors = colors.length ? colors : [[0.75, 0, 0]];
  }

  /** Colour at a point of the cycle (0..1 wraps), blended between neighbouring entries. */
  at(pos: number, out: Float32Array, o: number): void {
    const n = this.colors.length;
    const x = (((pos % 1) + 1) % 1) * n;
    const i = Math.floor(x);
    const k = x - i;
    const a = this.colors[i % n];
    const b = this.colors[(i + 1) % n];
    this.write(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, out, o);
  }

  /** Entry i (wrapping); −1 is white. */
  entry(i: number, out: Float32Array, o: number): void {
    if (i < 0) {
      out[o] = out[o + 1] = out[o + 2] = 1;
      return;
    }
    const c = this.colors[Math.floor(i) % this.colors.length];
    this.write(c[0], c[1], c[2], out, o);
  }

  private write(L: number, a: number, b: number, out: Float32Array, o: number): void {
    oklabToLinear(L, a, b, scratch, 0);
    out[o] = encodeSrgb(scratch[0]);
    out[o + 1] = encodeSrgb(scratch[1]);
    out[o + 2] = encodeSrgb(scratch[2]);
  }
}

/** A kick's light: 1 at the kick, then decaying; 0 before it. */
export const decay = (age: number, ms: number) => (age < 0 ? 0 : Math.exp(-age / ms));

export const TRIGGERS = { kick: 'Kicks', beat: 'Every beat', bar: 'Every bar' } as const;
export type Trigger = keyof typeof TRIGGERS;
export const TRIGGER_KEYS = Object.keys(TRIGGERS) as Trigger[];
export const triggerParam = (def: Trigger = 'kick', label = 'On'): ParamSpec => ({ kind: 'enum', label, options: TRIGGERS, default: def });

/**
 * How lit a hit of trigger `i` is now: 1 at the event (ramping over `softMs` when timing is
 * softened), then decaying; the previous event still fades out. Scaled by its react.
 */
export function hit(ctx: EffectContext, i: number, decayMs: number, delayMs = 0): number {
  const soft = ctx.softMs;
  const env = (age: number) => (age < 0 ? 0 : age < soft ? age / soft : Math.exp(-(age - soft) / decayMs));
  return ctx.trigReact[i] * Math.max(env(ctx.t - ctx.trigT[i] - delayMs), env(ctx.t - ctx.trigPrev[i] - delayMs));
}

/** Deterministic 0..1 noise from two integers (mulberry32 step). */
export function hash01(a: number, b: number): number {
  let x = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

export const axisParam = (def: Axis = 'x'): ParamSpec => ({ kind: 'enum', label: 'Direction', options: AXES, default: def });
export const AXIS_KEYS = Object.keys(AXES) as Axis[];
