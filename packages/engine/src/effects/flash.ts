import { decay, defineEffect } from '../effect.ts';

/** A flash on every kick; with a ripple it spreads outward from where you listen. */
export default defineEffect({
  id: 'flash',
  name: 'Kick flash',
  description: 'Flashes on every kick. Ripple makes it travel outward from where you listen',
  params: {
    color: { kind: 'color', label: 'Colour', default: -1 },
    strength: { kind: 'number', label: 'Strength', min: 0, max: 1, default: 1, step: 0.01 },
    decayMs: { kind: 'number', label: 'Fade', min: 30, max: 2000, default: 140, step: 10, unit: 'ms' },
    rippleMs: { kind: 'number', label: 'Ripple', min: 0, max: 1000, default: 0, step: 10, unit: 'ms' },
  },
  render(ctx, p, out, o) {
    const delay = ctx.axis.dist * p[3];
    const v = p[1] * ctx.react * Math.max(decay(ctx.t - ctx.onsetT - delay, p[2]), decay(ctx.t - ctx.prevOnsetT - delay, p[2]));
    ctx.palette.entry(p[0], out, o);
    out[o] *= v;
    out[o + 1] *= v;
    out[o + 2] *= v;
  },
});
