// musicsync server: wires the modules together, serves the web app, and runs the engine
// worker. One instance per bridge (architecture §10.1).
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { DEFAULT_MASTER, Master, type LiveState } from '@musicsync/protocol';
import { AnalysisModule } from './analysis.ts';
import { Director } from './director.ts';
import { loadLibrary, registerLibrary } from './library.ts';
import { registerAuth } from './auth.ts';
import { loadConfig } from './config.ts';
import { EngineHost } from './engine-host.ts';
import { HueModule } from './hue.ts';
import { loadLayout, registerLayout } from './layout.ts';
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

// Settings saved by an older version lack newer fields (and parsing drops retired ones).
const saved = Master.safeParse({ ...DEFAULT_MASTER, ...store.get<Partial<Master>>('master') });
const master: Master = saved.success ? saved.data : DEFAULT_MASTER;
const library = loadLibrary(store);
const initial: LiveState = {
  running: false,
  master,
  mode: 'idle',
  hue: { paired: false, lights: [], devices: [] },
  layout: loadLayout(store),
  library,
  program: { lookId: library.defaultLookId, reason: 'default', palette: [], auto: false },
  beat: { source: 'none' },
  delay: { key: 'none', label: 'the next device that plays', ms: 0 },
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
    if (msg.master.groups) hue.sendGains();
  } else if (msg.type === 'run') {
    director.run(msg.running);
  } else if (msg.type === 'look') {
    director.pick(msg.lookId);
  } else if (msg.type === 'taps') {
    const error = analysis.taps(msg.times, msg.sentAt);
    if (error) app.log.info(error);
  } else if (msg.type === 'nudge') {
    analysis.nudge(msg.ms);
  } else {
    analysis.clearGrid();
  }
});
const engine = new EngineHost(app.log, (msg) => {
  if (msg.type === 'frame') live.broadcast(msg);
  else if (msg.type === 'status') live.patch({ output: msg.status });
});
engine.send({ type: 'master', master });

const hue = new HueModule(app, store, live, engine);
registerLayout(app, store, live, () => void hue.resync());
registerLibrary(app, store, live);
const director = new Director(live, engine, app.log);
director.update();
const spotify = new SpotifyModule(app, config, store, live);
const analysis = new AnalysisModule(store, live, engine, app.log);
new SensorsModule(app, store, live, engine, analysis);
analysis.update();

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
