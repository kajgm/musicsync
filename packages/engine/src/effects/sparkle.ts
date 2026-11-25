import { decay, defineEffect, hash01 } from '../effect.ts';

/** On each kick a random few lights light up in a random palette colour. */
export default defineEffect({
  id: 'sparkle',
  name: 'Sparkle',
  description: 'On each kick, a random few lights light up in a palette colour',
  params: {
    density: { kind: 'number', label: 'Share of lights', min: 0, max: 1, default: 0.3, step: 0.01 },
    decayMs: { kind: 'number', label: 'Fade', min: 30, max: 2000, default: 300, step: 10, unit: 'ms' },
  },
  render(ctx, p, out, o) {
    const lit = hash01(ctx.onsets, ctx.channel) < p[0];
    const v = lit ? ctx.react * decay(ctx.t - ctx.onsetT, p[1]) : 0;
    ctx.palette.at(hash01(ctx.channel, ctx.onsets + 7919), out, o);
    out[o] *= v;
    out[o + 1] *= v;
    out[o + 2] *= v;
  },
});
