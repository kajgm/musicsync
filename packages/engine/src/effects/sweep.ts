import { AXIS_KEYS, axisParam, defineEffect, triggerParam } from '../effect.ts';

/** On each kick, beat or bar, a band of light runs across the lights. */
export default defineEffect({
  id: 'sweep',
  name: 'Sweep',
  description: 'On each kick, beat or bar, a band of light runs across the lights',
  params: {
    on: triggerParam('bar'),
    color: { kind: 'color', label: 'Colour', default: 0 },
    axis: axisParam('x'),
    width: { kind: 'number', label: 'Width', min: 0.05, max: 1, default: 0.3, step: 0.01 },
    durationMs: { kind: 'number', label: 'Duration', min: 100, max: 3000, default: 500, step: 10, unit: 'ms' },
  },
  render(ctx, p, out, o) {
    const age = ctx.t - ctx.trigT[p[0]];
    const width = p[3];
    let v = 0;
    if (age >= 0 && age < p[4]) {
      const centre = -width + (1 + 2 * width) * (age / p[4]);
      v = ctx.trigReact[p[0]] * Math.max(0, 1 - Math.abs(ctx.axis[AXIS_KEYS[p[2]]] - centre) / width);
    }
    ctx.palette.entry(p[1], out, o);
    out[o] *= v;
    out[o + 1] *= v;
    out[o + 2] *= v;
  },
});
