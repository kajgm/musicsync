import { AXIS_KEYS, axisParam, defineEffect, triggerParam } from '../effect.ts';

/** Palette colours spread across the lights, drifting over time and stepping on a trigger. */
export default defineEffect({
  id: 'wash',
  name: 'Colour wash',
  description: 'Palette colours spread across the lights, drifting slowly and stepping on each kick, beat or bar',
  params: {
    axis: axisParam('x'),
    spread: { kind: 'number', label: 'Spread', min: 0, max: 1, default: 0.4, step: 0.01 },
    drift: { kind: 'number', label: 'Drift', min: 0, max: 10, default: 1, step: 0.1, unit: '/min' },
    stepOn: triggerParam('kick', 'Step on'),
    kickStep: { kind: 'number', label: 'Step', min: 0, max: 0.5, default: 0.13, step: 0.01 },
    brightness: { kind: 'number', label: 'Brightness', min: 0, max: 1, default: 0.6, step: 0.01 },
  },
  render(ctx, p, out, o) {
    const pos = (ctx.t / 60_000) * p[2] + ctx.trigCount[p[3]] * p[4] + p[1] * ctx.axis[AXIS_KEYS[p[0]]];
    ctx.palette.at(pos, out, o);
    out[o] *= p[5];
    out[o + 1] *= p[5];
    out[o + 2] *= p[5];
  },
});
