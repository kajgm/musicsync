// The effect library. Add an effect: one file here, then list it below.
import type { EffectDef } from '../effect.ts';
import breathe from './breathe.ts';
import flash from './flash.ts';
import solid from './solid.ts';
import sparkle from './sparkle.ts';
import sweep from './sweep.ts';
import wash from './wash.ts';

export const EFFECTS: Record<string, EffectDef> = Object.fromEntries(
  [wash, flash, breathe, sparkle, sweep, solid].map((e) => [e.id, e]),
);
