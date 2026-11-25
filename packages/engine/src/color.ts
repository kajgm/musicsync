// Colour maths: OKLab/OKLCH (Björn Ottosson) and the sRGB transfer curve. Palettes are
// stored as OKLCH and blended in OKLab, so gradients between colours stay even.

export type Oklab = [number, number, number];
/** L 0..1, C 0..~0.37, H in degrees. */
export type Oklch = { l: number; c: number; h: number };

export function oklchToOklab({ l, c, h }: Oklch): Oklab {
  const r = (h * Math.PI) / 180;
  return [l, c * Math.cos(r), c * Math.sin(r)];
}

export function oklabToOklch([l, a, b]: Oklab): Oklch {
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { l, c: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

/** OKLab → linear sRGB, written to out[o..o + 2] (may fall outside 0..1). */
export function oklabToLinear(L: number, a: number, b: number, out: Float32Array | number[], o: number): void {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  out[o] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[o + 1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[o + 2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
}

export function linearToOklab(r: number, g: number, b: number): Oklab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363015264 * g + 0.0514770718 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** sRGB transfer curve: linear 0..1 → encoded 0..1 (clamped). */
export function encodeSrgb(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

export function decodeSrgb(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
