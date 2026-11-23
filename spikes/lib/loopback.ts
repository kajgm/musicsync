// Runs the Rust capture helper and turns its stdout into Float32Array blocks.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const HELPER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'audio',
  'loopback',
  'target',
  'release',
  process.platform === 'win32' ? 'loopback.exe' : 'loopback',
);

export type LoopbackHeader = { device: string; sampleRate: number; channels: number; format: string };
export type LoopbackStats = {
  callbacks: number;
  framesPerCallback: number;
  captureToCallbackMsAvg: number;
  captureToCallbackMsMax: number;
};

export type Loopback = {
  header: LoopbackHeader;
  proc: ChildProcess;
  onBlock(cb: (samples: Float32Array, tLast: number) => void): void;
  onStats(cb: (stats: LoopbackStats) => void): void;
  stop(): void;
};

export async function startLoopback(device?: string): Promise<Loopback> {
  if (!existsSync(HELPER)) throw new Error(`Capture helper not built yet: run \`npm run audio:build\` (${HELPER})`);
  const proc = spawn(HELPER, device ? ['--device', device] : [], { stdio: ['ignore', 'pipe', 'pipe'] });
  const blockCallbacks: Array<(samples: Float32Array, tLast: number) => void> = [];
  const statsCallbacks: Array<(stats: LoopbackStats) => void> = [];

  let remainder = Buffer.alloc(0);
  proc.stdout.on('data', (chunk: Buffer) => {
    const arrived = performance.now();
    const buf = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    const usable = buf.length - (buf.length % 4);
    remainder = Buffer.from(buf.subarray(usable));
    if (usable === 0) return;
    const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
    for (const cb of blockCallbacks) cb(samples, arrived);
  });

  const header = await new Promise<LoopbackHeader>((resolve, reject) => {
    createInterface({ input: proc.stderr }).on('line', (line) => {
      let msg: { header?: LoopbackHeader; stats?: LoopbackStats; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        console.error(`[loopback] ${line}`);
        return;
      }
      if (msg.header) resolve(msg.header);
      else if (msg.stats) for (const cb of statsCallbacks) cb(msg.stats);
      else if (msg.error) reject(new Error(msg.error));
      else console.error(`[loopback] ${line}`);
    });
    proc.once('exit', (code) => reject(new Error(`capture helper exited with code ${code}`)));
    proc.once('error', reject);
  });

  return {
    header,
    proc,
    onBlock: (cb) => void blockCallbacks.push(cb),
    onStats: (cb) => void statsCallbacks.push(cb),
    stop: () => void proc.kill(),
  };
}
