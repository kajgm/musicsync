import { defineEffect, hash01, hit, triggerParam } from '../effect.ts';

/** On each kick, beat or bar, a random few lights light up in a random palette colour. */
export default defineEffect({
  id: 'sparkle',
  name: 'Sparkle',
  description: 'On each kick, beat or bar, a random few lights light up in a palette colour',
  params: {
    on: triggerParam('kick'),
    density: { kind: 'number', label: 'Share of lights', min: 0, max: 1, default: 0.3, step: 0.01 },
    decayMs: { kind: 'number', label: 'Fade', min: 30, max: 2000, default: 300, step: 10, unit: 'ms' },
  },
  render(ctx, p, out, o) {
    const n = ctx.trigCount[p[0]];
    const v = hash01(n, ctx.channel) < p[1] ? hit(ctx, p[0], p[2]) : 0;
    ctx.palette.at(hash01(ctx.channel, n + 7919), out, o);
    out[o] *= v;
    out[o + 1] *= v;
    out[o + 2] *= v;
  },
});
