import { defineEffect } from '../effect.ts';

/** One palette colour. */
export default defineEffect({
  id: 'solid',
  name: 'Solid colour',
  description: 'One palette colour on every light',
  params: {
    color: { kind: 'color', label: 'Colour', default: 0 },
    brightness: { kind: 'number', label: 'Brightness', min: 0, max: 1, default: 0.6, step: 0.01 },
  },
  render(ctx, p, out, o) {
    ctx.palette.entry(p[0], out, o);
    out[o] *= p[1];
    out[o + 1] *= p[1];
    out[o + 2] *= p[1];
  },
});
