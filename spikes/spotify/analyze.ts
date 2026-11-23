// Spike 2c: re-analyze a clock log with round-trip-aware timestamps. Midpoint timing
// blames Spotify for network delay: on slow requests most of the extra delay comes after
// Spotify reads the position, so anchoring at send + min(round trip)/2 is closer.
// Usage: npm run spotify:analyze -- [path to a clock-*.csv]   (defaults to the newest)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_DIR } from '../lib/local.ts';

type Row = { device: string; track: string; playing: boolean; progress: number; rtt: number; offset: number };

const newest = readdirSync(LOCAL_DIR).filter((f) => /^clock-.*\.csv$/.test(f)).sort().at(-1);
const file = process.argv[2] ?? (newest ? join(LOCAL_DIR, newest) : '');
if (!file) throw new Error('No clock log yet: run `npm run spotify:clock` first.');

const rows: Row[] = readFileSync(file, 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => {
    const cells = [...line.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)].map((m) => m[2] ?? m[1] ?? '');
    return {
      device: cells[1],
      track: cells[3],
      playing: cells[4] === 'true',
      progress: Number(cells[5]),
      rtt: Number(cells[6]),
      offset: Number(cells[7]),
    };
  });

// Continuous plays: same device and track, playing, no jump over 1.5 s. Skip the start-up ramp.
const segments: Row[][] = [];
let current: Row[] | undefined;
let prev: Row | undefined;
for (const r of rows) {
  const fresh =
    !r.playing || !prev?.playing || r.device !== prev.device || r.track !== prev.track || Math.abs(r.offset - prev.offset) > 1500;
  if (fresh) {
    current = r.playing ? [] : undefined;
    if (current) segments.push(current);
  }
  if (current && r.progress >= 1500) current.push(r);
  prev = r;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const describe = (residuals: number[]) => {
  const abs = residuals.map(Math.abs).sort((a, b) => a - b);
  const p = (q: number) => abs[Math.min(abs.length - 1, Math.floor(q * abs.length))].toFixed(0).padStart(3);
  const sd = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / residuals.length).toFixed(0).padStart(3);
  return `n ${String(residuals.length).padStart(3)}  sd ${sd} ms  p50 ${p(0.5)}  p95 ${p(0.95)}  max ${p(1)} ms`;
};

console.log(`Analyzing ${file}\n`);
for (const device of new Set(rows.map((r) => r.device))) {
  const plays = segments.filter((s) => s.length >= 5 && s[0].device === device);
  if (plays.length === 0) continue;
  const minRtt = Math.min(...plays.flat().map((r) => r.rtt));
  const midpoint: number[] = [];
  const fastOnly: number[] = [];
  const anchored: number[] = [];
  for (const play of plays) {
    const m = median(play.map((r) => r.offset));
    for (const r of play) midpoint.push(r.offset - m);
    const fast = play.filter((r) => r.rtt <= minRtt + 30);
    const mf = median(fast.map((r) => r.offset));
    for (const r of fast) fastOnly.push(r.offset - mf);
    // offset was measured against the midpoint; re-anchor it at send + minRtt/2.
    const shifted = play.map((r) => r.offset + (r.rtt - minRtt) / 2);
    const ms = median(shifted);
    for (const s of shifted) anchored.push(s - ms);
  }
  console.log(`${device}  (min round trip ${minRtt.toFixed(0)} ms)`);
  console.log(`  midpoint timing, all samples          ${describe(midpoint)}`);
  console.log(`  midpoint timing, round trip ≤ min+30  ${describe(fastOnly)}`);
  console.log(`  send + min round trip / 2, all        ${describe(anchored)}`);
}
