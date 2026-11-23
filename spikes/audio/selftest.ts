// Spike 3b: play a quiet 120 BPM click track through the default output and check that
// loopback capture + onset detection recover it. Usage: npm run audio:selftest
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Analyzer, OnsetPicker, TempoTracker } from '../lib/dsp.ts';
import { localPath, sleep } from '../lib/local.ts';
import { startLoopback, type LoopbackStats } from '../lib/loopback.ts';

const BPM = 120;
const SR = 48000;
const DURATION_S = 11;
const AMPLITUDE = 0.15; // about -16 dBFS: audible, not loud

// Each click is a 60 Hz thump (kick-like) plus a 3 ms 3 kHz tick.
const clicks: number[] = [];
for (let t = 1; t < DURATION_S - 0.5; t += 60 / BPM) clicks.push(t);
const n = Math.round(DURATION_S * SR);
const pcm = new Int16Array(n);
for (const c of clicks) {
  const start = Math.round(c * SR);
  for (let i = 0; i < Math.round(0.12 * SR) && start + i < n; i++) {
    const t = i / SR;
    const thump = Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t / 0.04);
    const tick = t < 0.003 ? 0.5 * Math.sin(2 * Math.PI * 3000 * t) : 0;
    pcm[start + i] = Math.round(Math.max(-1, Math.min(1, AMPLITUDE * (thump + tick))) * 32767);
  }
}
const wav = Buffer.alloc(44 + n * 2);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + n * 2, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); // PCM
wav.writeUInt16LE(1, 22); // mono
wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(n * 2, 40);
Buffer.from(pcm.buffer).copy(wav, 44);
const wavPath = localPath('selftest-120bpm.wav');
writeFileSync(wavPath, wav);

const lb = await startLoopback();
console.log(`Capturing "${lb.header.device}" (${lb.header.sampleRate} Hz). Playing ${clicks.length} clicks at ${BPM} BPM...`);
const analyzer = new Analyzer(lb.header.sampleRate);
const picker = new OnsetPicker();
const tempo = new TempoTracker(analyzer.hopMs);
const onsets: number[] = [];
const stats: LoopbackStats[] = [];
lb.onStats((s) => s.callbacks > 0 && stats.push(s));
lb.onBlock((samples, tLast) =>
  analyzer.push(samples, tLast, (frame) => {
    tempo.push(frame.flux);
    const onset = picker.push(frame.lowFlux, frame.t);
    if (onset) onsets.push(onset.t);
  }),
);

await new Promise<void>((resolve, reject) => {
  const player = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer '${wavPath.replace(/'/g, "''")}').PlaySync()`],
    { stdio: 'ignore' },
  );
  player.once('exit', () => resolve());
  player.once('error', reject);
});
await sleep(1500);
const estimate = tempo.estimate();
lb.stop();

const expectedGap = 60000 / BPM;
const gaps = onsets.slice(1).map((t, i) => t - onsets[i]);
const deviations = gaps.map((g) => Math.abs(g - expectedGap));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sorted = [...gaps].sort((a, b) => a - b);

console.log(`Detected ${onsets.length} of ${clicks.length} clicks.`);
if (gaps.length) {
  console.log(
    `Gap between detections: median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms (expected ${expectedGap}), ` +
      `mean error ${mean(deviations).toFixed(1)} ms, worst ${Math.max(...deviations).toFixed(1)} ms.`,
  );
}
console.log(`Tempo estimate: ${estimate ? `${estimate.bpm.toFixed(1)} BPM (confidence ${estimate.confidence.toFixed(2)})` : 'n/a'}`);
if (stats.length) {
  console.log(
    `Capture: ${mean(stats.map((s) => s.framesPerCallback)).toFixed(0)} frames per callback, ` +
      `capture→callback avg ${mean(stats.map((s) => s.captureToCallbackMsAvg)).toFixed(1)} ms, max ${Math.max(...stats.map((s) => s.captureToCallbackMsMax)).toFixed(1)} ms.`,
  );
}
const pass =
  Math.abs(onsets.length - clicks.length) <= 1 &&
  mean(deviations) < 15 &&
  estimate !== undefined &&
  Math.abs(estimate.bpm - BPM) < 2;
console.log(pass ? 'SELF-TEST PASSED' : 'SELF-TEST FAILED');
process.exit(pass ? 0 : 1);
