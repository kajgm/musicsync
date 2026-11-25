// Album-art palettes: the cover's main colours, made light-friendly. k-means in OKLab on
// the coloured pixels, then lifted to a lightness and chroma bulbs show well.
import jpeg from 'jpeg-js';
import { decodeSrgb, linearToOklab, oklabToOklch, type Oklab } from '@musicsync/engine';
import type { Oklch } from '@musicsync/protocol';

const MAX_BYTES = 512 * 1024;
const CACHE = 100;

/** Up to `k` colours from RGBA pixels, sorted by hue; undefined if the image is mostly grey. */
export function paletteFromPixels(rgba: Uint8Array, k = 5): Oklch[] | undefined {
  const points: Oklab[] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4 * 3) {
    // every third pixel is plenty
    const lab = linearToOklab(decodeSrgb(rgba[i] / 255), decodeSrgb(rgba[i + 1] / 255), decodeSrgb(rgba[i + 2] / 255));
    if (lab[0] > 0.15 && Math.hypot(lab[1], lab[2]) > 0.04) points.push(lab);
  }
  if (points.length < 20) return undefined;

  // Deterministic start: the point farthest from those already chosen.
  const centres: Oklab[] = [points[0]];
  const d2 = (a: Oklab, b: Oklab) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  while (centres.length < k) {
    let best = points[0];
    let bestD = -1;
    for (const p of points) {
      const d = Math.min(...centres.map((c) => d2(p, c)));
      if (d > bestD) [best, bestD] = [p, d];
    }
    if (bestD < 1e-4) break;
    centres.push(best);
  }
  const counts = new Array<number>(centres.length).fill(0);
  for (let iter = 0; iter < 8; iter++) {
    const sums = centres.map(() => [0, 0, 0]);
    counts.fill(0);
    for (const p of points) {
      let j = 0;
      for (let c = 1; c < centres.length; c++) if (d2(p, centres[c]) < d2(p, centres[j])) j = c;
      counts[j]++;
      sums[j][0] += p[0];
      sums[j][1] += p[1];
      sums[j][2] += p[2];
    }
    centres.forEach((c, j) => counts[j] && (centres[j] = [sums[j][0] / counts[j], sums[j][1] / counts[j], sums[j][2] / counts[j]]));
  }
  const colors = centres
    .filter((_, j) => counts[j] >= points.length * 0.03) // ignore specks
    .map((c) => oklabToOklch(c))
    .map((c) => ({ l: Math.min(0.8, Math.max(0.6, c.l)), c: Math.min(0.25, Math.max(0.1, c.c)), h: Math.round(c.h) }))
    .sort((a, b) => a.h - b.h);
  // Drop near-duplicates (hue within 12°).
  const out = colors.filter((c, i) => i === 0 || Math.abs(c.h - colors[i - 1].h) > 12);
  return out.length ? out : undefined;
}

const cache = new Map<string, Oklch[] | undefined>();

/** The palette of a Spotify cover image, cached by URL. Only Spotify's image CDN is fetched. */
export async function albumPalette(url: string): Promise<Oklch[] | undefined> {
  if (cache.has(url)) return cache.get(url);
  const host = new URL(url).hostname;
  if (!url.startsWith('https://') || !(host.endsWith('.scdn.co') || host.endsWith('.spotifycdn.com'))) return undefined;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Cover image: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('Cover image too large');
  const image = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 2, maxMemoryUsageInMB: 64 });
  const palette = paletteFromPixels(image.data);
  if (cache.size >= CACHE) cache.delete(cache.keys().next().value!);
  cache.set(url, palette);
  return palette;
}
