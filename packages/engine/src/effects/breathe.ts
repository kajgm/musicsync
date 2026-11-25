import { AXIS_KEYS, axisParam, defineEffect } from '../effect.ts';

/** A slow rise and fall in brightness, drifting across the lights. Use with Multiply. */
export default defineEffect({
  id: 'breathe',
  name: 'Breathe',
  description: 'A slow rise and fall, drifting across the lights. Use it with the Multiply blend',
  params: {
    periodS: { kind: 'number', label: 'Period', min: 0.5, max: 30, default: 7, step: 0.5, unit: 's' },
    depth: { kind: 'number', label: 'Depth', min: 0, max: 1, default: 0.3, step: 0.01 },
    axis: axisParam('x'),
    spread: { kind: 'number', label: 'Spread', min: 0, max: 1, default: 0.4, step: 0.01 },
  },
  render(ctx, p, out, o) {
    const phase = (ctx.t / (p[0] * 1000) + p[3] * ctx.axis[AXIS_KEYS[p[2]]]) * 2 * Math.PI;
    out[o] = out[o + 1] = out[o + 2] = 1 - p[1] * (0.5 + 0.5 * Math.sin(phase));
  },
});
