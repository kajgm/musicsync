// Spike 4: end to end. Kick drums detected in the PC's audio (loopback) flash the bulbs
// over the Hue Entertainment stream. Play Spotify on the PC, then press + / - to delay the
// lights in 10 ms steps until the flashes land on the beat you hear; 0 resets, q quits.
// The delay is saved per output device.
// Usage: npm run demo:flash -- [--device <name>] [--offset <ms>] [--seconds <n>]
import { hsv, type RGB } from '../lib/color.ts';
import { Analyzer, OnsetPicker } from '../lib/dsp.ts';
import { clip, loadCreds, type EntertainmentConfig } from '../lib/hue.ts';
import { openHueStream } from '../lib/huestream.ts';
import { readLocal, writeLocal } from '../lib/local.ts';
import { startLoopback } from '../lib/loopback.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const HZ = 50;
const DECAY_MS = 140;

const area = (await clip<EntertainmentConfig>('GET', 'entertainment_configuration')).find(
  (a) => a.metadata.name === 'musicsync',
);
if (!area) throw new Error('No "musicsync" Entertainment area: run `npm run hue:area` first.');

const lb = await startLoopback(arg('--device'));
const offsets = readLocal<Record<string, number>>('offsets.json') ?? {};
let delayMs = Number(arg('--offset') ?? offsets[lb.header.device] ?? 0);
const stream = await openHueStream(loadCreds(), area);
console.log(`Listening to "${lb.header.device}"; streaming to ${area.channels.length} bulbs.`);
console.log('Play Spotify on this PC. + / - shifts the lights 10 ms later/earlier, 0 resets, q quits.\n');

const analyzer = new Analyzer(lb.header.sampleRate);
const kicks = new OnsetPicker();
const due: number[] = []; // flash times, performance.now() ms
lb.onBlock((samples, tLast) =>
  analyzer.push(samples, tLast, (frame) => {
    const onset = kicks.push(frame.lowFlux, frame.t);
    if (onset) due.push(onset.t + delayMs); // onset.t is when the kick was captured
  }),
);

const channels = area.channels.map((c) => c.channel_id);
const envelope = new Float64Array(channels.length);
const decay = Math.exp(-1000 / HZ / DECAY_MS);
let hue = Math.random();
let flashes = 0;
const start = performance.now();
let frames = 0;
const tick = () => {
  const now = performance.now();
  while (due.length && due[0] <= now) {
    due.shift();
    flashes++;
    hue = (hue + 0.13) % 1;
    envelope.fill(1);
  }
  const color = hsv(hue, 0.85, 1);
  stream.send(
    channels.map((channel, i) => {
      const level = 0.06 + 0.94 * envelope[i];
      envelope[i] *= decay;
      return { channel, rgb: [color[0] * level, color[1] * level, color[2] * level] as RGB };
    }),
  );
  frames++;
  setTimeout(tick, Math.max(0, start + (frames * 1000) / HZ - performance.now()));
};
tick();

const show = () => process.stdout.write(`\rlight delay ${String(delayMs).padStart(4)} ms   flashes ${flashes}      `);
setInterval(show, 500);

let quitting = false;
async function quit() {
  if (quitting) return;
  quitting = true;
  offsets[lb.header.device] = delayMs;
  writeLocal('offsets.json', offsets);
  lb.stop();
  await stream.close();
  console.log(`\n${flashes} flashes. Saved a ${delayMs} ms light delay for "${lb.header.device}".`);
  process.exit(0);
}
process.on('SIGINT', () => void quit());
const runSeconds = Number(arg('--seconds') ?? 0);
if (runSeconds > 0) setTimeout(() => void quit(), runSeconds * 1000);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (key: Buffer) => {
    const k = key.toString();
    if (k === '+' || k === '=') delayMs += 10;
    else if (k === '-' || k === '_') delayMs = Math.max(0, delayMs - 10);
    else if (k === '0') delayMs = 0;
    else if (k === 'q' || k === '\u0003') void quit();
    show();
  });
}
