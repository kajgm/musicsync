// Engine worker: renders at a fixed 50 Hz and feeds the lights (Hue Entertainment stream)
// and the preview. Nothing slow runs on this thread; the control plane sends it settings
// and audio features as messages.
import { parentPort } from 'node:worker_threads';
import { Engine, type BeatClock, type Program, type TrackClock } from '@musicsync/engine';
import { openHueStream, type HueStream } from '@musicsync/hue';
import { DEFAULT_MASTER, type LiveState, type Master } from '@musicsync/protocol';
import { SIM_CHANNELS, now, type FromWorker, type HueTarget, type ToWorker } from './engine-host.ts';

const HZ = 50;
const PREVIEW_EVERY = 2; // 25 Hz preview
const RETRY_MS = 5000;

const port = parentPort;
if (!port) throw new Error('engine-worker.ts runs as a worker thread');
const post = (msg: FromWorker) => port.postMessage(msg);

let engine = new Engine(SIM_CHANNELS);
let master: Master = DEFAULT_MASTER;
let gains: number[] = [];
let program: Program | undefined;
let beats: BeatClock | undefined;
let track: TrackClock | undefined;
/** Live audio waits this long (ms) to line up with the speaker. */
let delayMs = 0;
/** The engine is rebuilt only when the channel layout changes, so pausing doesn't reset it. */
let layoutKey = '0';
let target: HueTarget | null = null;
let running = false;
let stream: { session: HueStream; target: HueTarget } | undefined;
let status: LiveState['output'] = { status: 'no-bridge', fps: 0 };
let fps = 0;
/** Audio waiting for the light delay, oldest first. */
const audio: Array<Extract<ToWorker, { type: 'audio' }>> = [];

function setStatus(next: Omit<LiveState['output'], 'fps'>): void {
  status = { ...next, fps };
  post({ type: 'status', status });
}

// Opens or closes the Hue stream until it matches `running` and `target`. One pass at a
// time; a change during a pass triggers another.
let busy = false;
let again = false;
let retry: NodeJS.Timeout | undefined;
async function reconcile(): Promise<void> {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  clearTimeout(retry);
  try {
    do {
      again = false;
      const want = running ? target : null;
      if (stream && stream.target !== want) {
        const { session } = stream;
        stream = undefined;
        await session.close().catch((err: Error) => setStatus({ status: 'error', error: `Stopping the stream: ${err.message}` }));
      }
      if (want && !stream) {
        setStatus({ status: 'connecting' });
        try {
          const session = await openHueStream(want.creds, want.areaId, want.channels);
          const opened = { session, target: want };
          stream = opened;
          session.onDown((reason) => {
            if (stream !== opened) return;
            stream = undefined;
            setStatus({ status: 'error', error: reason });
            retry = setTimeout(() => void reconcile(), RETRY_MS);
          });
          setStatus({ status: 'streaming' });
        } catch (err) {
          setStatus({ status: 'error', error: (err as Error).message });
          retry = setTimeout(() => void reconcile(), RETRY_MS);
          break;
        }
      }
      if (!want) setStatus({ status: target ? 'off' : 'no-bridge' });
    } while (again);
  } finally {
    busy = false;
  }
}

const hex = (v: number) => Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255).toString(16).padStart(2, '0');

port.on('message', (msg: ToWorker) => {
  switch (msg.type) {
    case 'audio':
      if (audio.length < 1000) audio.push(msg);
      break;
    case 'master':
      master = msg.master;
      break;
    case 'gains':
      gains = msg.gains;
      engine.setGains(gains);
      break;
    case 'track':
      track = msg.clock;
      engine.setTrack(track);
      break;
    case 'beats':
      beats = msg.clock;
      engine.setBeats(beats);
      break;
    case 'delay':
      delayMs = Math.max(0, msg.ms);
      break;
    case 'program':
      program = msg.program;
      engine.setProgram(program);
      break;
    case 'run':
      running = msg.running;
      void reconcile();
      break;
    case 'output': {
      // Messages arrive as copies, so compare by value: an equal target keeps the stream open.
      if (JSON.stringify(msg.hue) !== JSON.stringify(target)) target = msg.hue;
      const key = JSON.stringify(msg.layout);
      if (key !== layoutKey) {
        layoutKey = key;
        const { layout } = msg;
        engine = new Engine(layout === 0 || (Array.isArray(layout) && layout.length === 0) ? SIM_CHANNELS : layout);
        engine.setGains(gains);
        if (program) engine.setProgram(program);
        engine.setBeats(beats);
        engine.setTrack(track);
      }
      void reconcile();
      break;
    }
    case 'shutdown':
      running = false;
      void reconcile().finally(() => post({ type: 'stopped' }));
      break;
  }
});

// Fixed-rate loop. Each tick renders for the current time and is scheduled against the
// start, so timer jitter shifts a frame by a few ms but never accumulates.
const start = performance.now();
let frames = 0;
let statsFrom = start;
let statsFrames = 0;
function tick(): void {
  const t = now();
  while (audio.length && audio[0].t + delayMs <= t) {
    const a = audio.shift()!;
    const at = a.t + delayMs;
    engine.audio(at, a);
    if (a.onset) engine.onset(at);
  }
  const rgb = engine.render(t, master);
  stream?.session.send(rgb);
  if (frames % PREVIEW_EVERY === 0) {
    const colors: string[] = [];
    for (let i = 0; i < rgb.length; i += 3) colors.push(`#${hex(rgb[i])}${hex(rgb[i + 1])}${hex(rgb[i + 2])}`);
    post({ type: 'frame', colors });
  }
  frames++;
  statsFrames++;
  const elapsed = performance.now() - statsFrom;
  if (elapsed >= 5000) {
    fps = Math.round((statsFrames * 1000) / elapsed);
    [statsFrom, statsFrames] = [performance.now(), 0];
    setStatus(status);
  }
  setTimeout(tick, Math.max(0, start + (frames * 1000) / HZ - performance.now()));
}
tick();
