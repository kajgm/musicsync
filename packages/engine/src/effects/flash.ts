import { defineEffect, hit, triggerParam } from '../effect.ts';

/** A flash on every kick, beat or bar; with a ripple it spreads outward from where you listen. */
export default defineEffect({
  id: 'flash',
  name: 'Flash',
  description: 'Flashes on every kick, beat or bar. Ripple makes it travel outward from where you listen',
  params: {
    on: triggerParam('kick'),
    color: { kind: 'color', label: 'Colour', default: -1 },
    strength: { kind: 'number', label: 'Strength', min: 0, max: 1, default: 1, step: 0.01 },
    decayMs: { kind: 'number', label: 'Fade', min: 30, max: 2000, default: 140, step: 10, unit: 'ms' },
    rippleMs: { kind: 'number', label: 'Ripple', min: 0, max: 1000, default: 0, step: 10, unit: 'ms' },
  },
  render(ctx, p, out, o) {
    const v = p[2] * hit(ctx, p[0], p[3], ctx.axis.dist * p[4]);
    ctx.palette.entry(p[1], out, o);
    out[o] *= v;
    out[o + 1] *= v;
    out[o + 2] *= v;
  },
});
