import { AXIS_KEYS, axisParam, defineEffect } from '../effect.ts';

/** On each kick, a band of light runs across the lights. */
export default defineEffect({
  id: 'sweep',
  name: 'Sweep',
  description: 'On each kick, a band of light runs across the lights',
  params: {
    color: { kind: 'color', label: 'Colour', default: 0 },
    axis: axisParam('x'),
    width: { kind: 'number', label: 'Width', min: 0.05, max: 1, default: 0.3, step: 0.01 },
    durationMs: { kind: 'number', label: 'Duration', min: 100, max: 3000, default: 500, step: 10, unit: 'ms' },
  },
  render(ctx, p, out, o) {
    const age = ctx.t - ctx.onsetT;
    const width = p[2];
    let v = 0;
    if (age >= 0 && age < p[3]) {
      const centre = -width + (1 + 2 * width) * (age / p[3]);
      v = ctx.react * Math.max(0, 1 - Math.abs(ctx.axis[AXIS_KEYS[p[1]]] - centre) / width);
    }
    ctx.palette.entry(p[0], out, o);
    out[o] *= v;
    out[o + 1] *= v;
    out[o + 2] *= v;
  },
});
