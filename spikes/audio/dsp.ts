// Spike 3a: analyze what the PC is playing. Prints kick onsets and, every 2 s, the
// tempo estimate, level, band meter and capture timing.
// Usage: npm run audio:dsp -- [--device <name>] [--seconds N]
import { Analyzer, OnsetPicker, TempoTracker, type Frame } from '../lib/dsp.ts';
import { startLoopback, type LoopbackStats } from '../lib/loopback.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const seconds = Number(arg('--seconds') ?? 0); // 0 = until Ctrl+C

const lb = await startLoopback(arg('--device'));
const { device, sampleRate, channels, format } = lb.header;
console.log(`Capturing "${device}" (${sampleRate} Hz, ${channels} ch, ${format}) via WASAPI loopback.`);
console.log('Play something on this PC (Spotify desktop). Ctrl+C to stop.\n');

const analyzer = new Analyzer(sampleRate);
const kicks = new OnsetPicker();
const tempo = new TempoTracker(analyzer.hopMs);
const t0 = performance.now();
let latest: Frame | undefined;
let kickCount = 0;
let capture: LoopbackStats | undefined;

lb.onStats((s) => {
  if (s.callbacks > 0) capture = s;
});
lb.onBlock((samples, tLast) =>
  analyzer.push(samples, tLast, (frame) => {
    latest = frame;
    tempo.push(frame.flux);
    const onset = kicks.push(frame.lowFlux, frame.t);
    if (onset) {
      kickCount++;
      const sinceCapture = performance.now() - onset.t + (capture?.captureToCallbackMsAvg ?? 0);
      console.log(
        `kick  ${((onset.t - t0) / 1000).toFixed(2).padStart(7)} s   strength ${onset.strength.toFixed(1).padStart(5)}   known ${sinceCapture.toFixed(0)} ms after capture`,
      );
    }
  }),
);

const meter = (db: number) => '▁▂▃▄▅▆▇█'[Math.max(0, Math.min(7, Math.round(((db + 80) / 80) * 7)))];
let lastKicks = 0;
setInterval(() => {
  const est = tempo.estimate();
  const level = latest ? (20 * Math.log10(latest.rms + 1e-9)).toFixed(0) : '-';
  const bands = latest ? Array.from(latest.bands, meter).join('') : '';
  const cap = capture
    ? `capture: ${capture.framesPerCallback} frames/callback, capture→callback avg ${capture.captureToCallbackMsAvg.toFixed(1)} ms`
    : 'capture: no audio playing';
  console.log(
    `  ── tempo ${est ? `${est.bpm.toFixed(1)} BPM (conf ${est.confidence.toFixed(2)})` : 'n/a'} · kicks ${((kickCount - lastKicks) / 2).toFixed(1)}/s · level ${level} dBFS · bands ${bands} · ${cap}`,
  );
  lastKicks = kickCount;
}, 2000);

const stop = () => {
  lb.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
if (seconds > 0) setTimeout(stop, seconds * 1000);
