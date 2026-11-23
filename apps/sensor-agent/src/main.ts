// Loopback agent: captures what this PC plays (WASAPI loopback through the native helper),
// turns it into feature frames (levels, bands, onset strength) and streams them to the
// musicsync server. Audio is analysed in memory only; none is recorded or sent.
//   npm run agent -- --url https://musicsync.lab.kajgm.com --token <agent token from Setup>
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Analyzer, type Frame } from '@musicsync/audio-features';
import type { AgentMessage, ServerToAgent } from '@musicsync/protocol';

const VERSION = '0.1.0';
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const url = arg('--url') ?? process.env.MUSICSYNC_URL;
const token = arg('--token') ?? process.env.MUSICSYNC_AGENT_TOKEN ?? '';
const device = arg('--device');
if (!url || !token) {
  console.error('Usage: npm run agent -- --url https://<server> --token <agent token from Setup> [--device <name>]');
  process.exit(1);
}
const wsUrl = new URL('/api/agent', url);
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const HELPER = fileURLToPath(
  new URL(`../native/target/release/loopback${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url),
);

const local = () => performance.timeOrigin + performance.now();
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// Clock sync: server time = local time + offset, from the fastest recent ping (NTP-style).
const pings: Array<{ rtt: number; offset: number }> = [];
let offset: number | undefined;

let socket: WebSocket | undefined;
let ready = false;
let deviceName = '';
let backoff = 1000;

function connect(): void {
  const ws = new WebSocket(wsUrl);
  socket = ws;
  let pinger: NodeJS.Timeout | undefined;
  const send = (msg: AgentMessage) => ws.send(JSON.stringify(msg));
  ws.onopen = () => send({ type: 'hello', token, device: deviceName, version: VERSION });
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as ServerToAgent;
    if (msg.type === 'welcome') {
      log(`Connected to ${wsUrl.origin}`);
      backoff = 1000;
      ready = true;
      const ping = () => send({ type: 'ping', t0: local() });
      ping();
      pinger = setInterval(ping, 2000);
    } else if (msg.type === 'pong') {
      const t1 = local();
      pings.push({ rtt: t1 - msg.t0, offset: msg.t - (msg.t0 + t1) / 2 });
      if (pings.length > 15) pings.shift();
      offset = pings.reduce((best, p) => (p.rtt < best.rtt ? p : best)).offset;
    }
  };
  ws.onerror = () => undefined; // onclose follows with the reason
  ws.onclose = (event) => {
    clearInterval(pinger);
    ready = false;
    if (event.code === 4401) log('The server rejected the token: copy it again from Setup.');
    log(`Disconnected (${event.code}${event.reason ? ` ${event.reason}` : ''}); retrying in ${backoff / 1000} s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
}

function sendFrame(frame: Frame): void {
  if (!ready || offset === undefined || socket?.readyState !== WebSocket.OPEN) return;
  const msg: AgentMessage = {
    type: 'frame',
    t: frame.t + offset,
    rms: r3(frame.rms),
    bands: Array.from(frame.bands, (b) => Math.round(b * 10) / 10),
    flux: r3(frame.flux),
    lowFlux: r3(frame.lowFlux),
  };
  socket.send(JSON.stringify(msg));
}

function startCapture(): void {
  if (!existsSync(HELPER)) {
    console.error(`The capture helper isn't built: run \`npm run build:native -w @musicsync/sensor-agent\` (${HELPER})`);
    process.exit(1);
  }
  const proc = spawn(HELPER, device ? ['--device', device] : [], { stdio: ['ignore', 'pipe', 'pipe'] });
  let analyzer: Analyzer | undefined;
  let remainder = Buffer.alloc(0);
  proc.stdout.on('data', (chunk: Buffer) => {
    const arrived = local();
    const buf = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    const usable = buf.length - (buf.length % 4);
    remainder = Buffer.from(buf.subarray(usable));
    if (usable === 0 || !analyzer) return;
    const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
    analyzer.push(samples, arrived, sendFrame);
  });
  createInterface({ input: proc.stderr }).on('line', (line) => {
    let msg: { header?: { device: string; sampleRate: number }; error?: string; streamError?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      log(`[helper] ${line}`);
      return;
    }
    if (msg.header) {
      deviceName = msg.header.device;
      analyzer = new Analyzer(msg.header.sampleRate);
      log(`Capturing "${deviceName}" at ${msg.header.sampleRate} Hz`);
      if (!socket) connect();
    } else if (msg.error || msg.streamError) {
      log(`Capture error: ${msg.error ?? msg.streamError}`);
    }
  });
  proc.on('exit', (code) => {
    log(`The capture helper exited (code ${code}); restarting in 2 s`);
    setTimeout(startCapture, 2000);
  });
}

startCapture();
