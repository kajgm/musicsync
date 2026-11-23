// Spike 1c: stream a test pattern to the "musicsync" area at 50 Hz and report timing.
// First half: a rainbow chase across the bulbs. Second half: white pulses at 2 Hz
// (to judge how crisp transitions are). Usage: npm run hue:stream -- [seconds]
import { clip, loadCreds, type EntertainmentConfig } from '../lib/hue.ts';
import { hsv, type RGB } from '../lib/color.ts';
import { openHueStream } from '../lib/huestream.ts';

const seconds = Number(process.argv[2] ?? 20);
const HZ = 50;

const area = (await clip<EntertainmentConfig>('GET', 'entertainment_configuration')).find(
  (a) => a.metadata.name === 'musicsync',
);
if (!area) throw new Error('No "musicsync" Entertainment area: run `npm run hue:area` first.');

const stream = await openHueStream(loadCreds(), area);
process.on('SIGINT', () => {
  void stream.close().finally(() => process.exit(130));
});
console.log(`DTLS handshake took ${stream.handshakeMs.toFixed(0)} ms; streaming ${area.channels.length} channels at ${HZ} Hz for ${seconds} s.`);

const channels = area.channels.map((c) => c.channel_id);
const start = performance.now();
const gaps: number[] = [];
let frames = 0;
let last = start;

// Checked while streaming, so a failure here must not kill the stream.
void clip<EntertainmentConfig>('GET', `entertainment_configuration/${area.id}`)
  .then(([live]) => console.log(`Bridge reports the area as "${live?.status}".`))
  .catch((err: Error) => console.error(`Status check failed: ${err.message}`));

await new Promise<void>((resolve) => {
  const tick = () => {
    const now = performance.now();
    const t = (now - start) / 1000;
    if (t >= seconds) return resolve();
    let colors: RGB[];
    if (t < seconds / 2) {
      colors = channels.map((_, i) => hsv((t * 0.25 + i / channels.length) % 1, 1, 1));
    } else {
      const phase = (t * 2) % 1; // 2 Hz
      const level = phase < 0.08 ? 1 : 0.05;
      colors = channels.map(() => [level, level, level]);
    }
    stream.send(channels.map((channel, i) => ({ channel, rgb: colors[i]! })));
    frames++;
    if (frames > 1) gaps.push(now - last);
    last = now;
    // Schedule against the start time so jitter never accumulates.
    setTimeout(tick, Math.max(0, start + (frames * 1000) / HZ - performance.now()));
  };
  tick();
});

await stream.close();
gaps.sort((a, b) => a - b);
const pct = (p: number) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))]!.toFixed(1);
const elapsed = (last - start) / 1000;
console.log(`Sent ${frames} frames in ${elapsed.toFixed(1)} s = ${(frames / elapsed).toFixed(1)} Hz.`);
console.log(`Frame gap ms: p50 ${pct(0.5)}, p95 ${pct(0.95)}, p99 ${pct(0.99)}, max ${gaps.at(-1)?.toFixed(1)}. DTLS errors: ${stream.sendErrors}.`);
console.log('Stream stopped; the bulbs return to normal control.');
