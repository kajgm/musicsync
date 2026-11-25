// Runs the engine worker (50 Hz render + light output) and restarts it if it dies.
import { Worker } from 'node:worker_threads';
import type { FastifyBaseLogger } from 'fastify';
import type { BeatClock, Position, Program } from '@musicsync/engine';
import type { HueCreds } from '@musicsync/hue';
import type { LiveState, Master } from '@musicsync/protocol';

export type HueTarget = { creds: HueCreds; areaId: string; channels: number[] };

export type ToWorker =
  /**
   * Where frames go: the Hue area, or nowhere but the preview (the simulator). `layout` is
   * each channel's position, or a channel count (lights in a line; 0 = the simulator's 7).
   */
  | { type: 'output'; hue: HueTarget | null; layout: number | Position[] }
  /** Group fader level per channel. */
  | { type: 'gains'; gains: number[] }
  | { type: 'run'; running: boolean }
  | { type: 'master'; master: Master }
  /** The look to run, compiled for the current channels. */
  | { type: 'program'; program: Program }
  /** Where the beats fall (undefined: no beat to follow). */
  | { type: 'beats'; clock?: BeatClock }
  /** Live audio waits this long before it reaches the lights (≥ 0). */
  | { type: 'delay'; ms: number }
  /** Gain-controlled audio features; `t` is server time (epoch ms) of the audio. */
  | { type: 'audio'; t: number; level: number; bass: number; mid: number; high: number; onset: boolean }
  | { type: 'shutdown' };

export type FromWorker =
  | { type: 'frame'; colors: string[] }
  | { type: 'status'; status: LiveState['output'] }
  | { type: 'stopped' };

/** Epoch ms with sub-ms resolution, consistent across threads. */
export const now = () => performance.timeOrigin + performance.now();

export class EngineHost {
  private readonly log: FastifyBaseLogger;
  private readonly onMessage: (msg: FromWorker) => void;
  /** The latest settings, replayed into a restarted worker. */
  private readonly latest = new Map<string, ToWorker>();
  private readonly statusWaiters = new Set<(status: LiveState['output']['status']) => void>();
  private worker: Worker;
  private stopping = false;

  constructor(log: FastifyBaseLogger, onMessage: (msg: FromWorker) => void) {
    this.log = log;
    this.onMessage = onMessage;
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const worker = new Worker(new URL('./engine-worker.ts', import.meta.url));
    worker.on('message', (msg: FromWorker) => {
      if (msg.type === 'status') for (const waiter of this.statusWaiters) waiter(msg.status.status);
      this.onMessage(msg);
    });
    worker.on('error', (err) => this.log.error({ err }, 'engine worker failed'));
    worker.on('exit', (code) => {
      if (this.stopping) return;
      this.log.error({ code }, 'engine worker exited; restarting in 1 s');
      setTimeout(() => {
        this.worker = this.spawn();
        for (const msg of this.latest.values()) this.worker.postMessage(msg);
      }, 1000);
    });
    return worker;
  }

  send(msg: ToWorker): void {
    if (msg.type !== 'audio') this.latest.set(msg.type, msg);
    this.worker.postMessage(msg);
  }

  /**
   * Stops streaming until the next 'output' with a target, so the Entertainment area can
   * be changed. Resolves once the stream is closed, or after 3 s.
   */
  pauseOutput(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.statusWaiters.delete(waiter);
        resolve();
      };
      const waiter = (status: string) => {
        if (status !== 'streaming' && status !== 'connecting') done();
      };
      const timer = setTimeout(done, 3000);
      this.statusWaiters.add(waiter);
      const last = this.latest.get('output');
      this.send({ type: 'output', hue: null, layout: last?.type === 'output' ? last.layout : 0 });
    });
  }

  /** Stops streaming (the bridge gives the lights back) and ends the worker. */
  async stop(): Promise<void> {
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 3000);
      this.worker.on('message', (msg: FromWorker) => {
        if (msg.type === 'stopped') {
          clearTimeout(done);
          resolve();
        }
      });
      this.worker.postMessage({ type: 'shutdown' } satisfies ToWorker);
    });
    await this.worker.terminate();
  }
}
