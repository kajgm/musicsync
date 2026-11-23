// musicsync server: wires the modules together, serves the web app, and runs the engine
// worker. One instance per bridge (architecture §10.1).
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { LiveState, Master } from '@musicsync/protocol';
import { registerAuth } from './auth.ts';
import { loadConfig } from './config.ts';
import { EngineHost } from './engine-host.ts';
import { HueModule } from './hue.ts';
import { Live } from './live.ts';
import { SensorsModule } from './sensors.ts';
import { SpotifyModule } from './spotify.ts';
import { Store } from './store.ts';

const config = loadConfig();
const store = new Store(config.dataDir, config.masterKey);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 64 * 1024 });
await app.register(cookie, { secret: createHmac('sha256', config.masterKey).update('session-cookie').digest() });
await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
registerAuth(app, config);
app.get('/healthz', async () => ({ ok: true, version: config.version }));

const master: Master = store.get<Master>('master') ?? { brightness: 0.8, intensity: 0.8, blackout: false, delayMs: 0 };
const initial: LiveState = {
  running: false,
  master,
  mode: 'idle',
  hue: { paired: false, lights: [] },
  spotify: {
    configured: Boolean(config.spotifyClientId),
    redirectUri: `${config.publicUrl}/api/auth/spotify/callback`,
    linked: false,
    playing: false,
  },
  agent: { connected: false },
  output: { status: 'no-bridge', fps: 0 },
};

const live = new Live(app, initial, (msg) => {
  if (msg.type === 'master') {
    const next = { ...live.state.master, ...msg.master };
    store.set('master', next);
    engine.send({ type: 'master', master: next });
    live.patch({ master: next });
  } else {
    engine.send({ type: 'run', running: msg.running });
    live.patch({ running: msg.running });
  }
});
const engine = new EngineHost(app.log, (msg) => {
  if (msg.type === 'frame') live.broadcast(msg);
  else if (msg.type === 'status') live.patch({ output: msg.status });
});
engine.send({ type: 'master', master });

const hue = new HueModule(app, store, live, engine);
const spotify = new SpotifyModule(app, config, store, live);
new SensorsModule(app, store, live, engine);

if (existsSync(config.webDir)) await app.register(fastifyStatic, { root: config.webDir });
else app.log.warn(`No web app at ${config.webDir}: run \`npm run build\` (or use \`npm run dev:web\`)`);

await app.listen({ port: config.port, host: config.host });
void hue.load();
spotify.start();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal}: stopping the light stream`);
  await engine.stop(); // the bridge gives the lights back
  await app.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
