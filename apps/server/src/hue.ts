// devices module: pair with the bridge (link button), follow its event stream for added,
// removed and renamed lights, and keep the app's Entertainment area matching the layout's
// stage: its lights and their positions. Then point the engine at it.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Position } from '@musicsync/engine';
import { AREA_MAX, pair, syncArea, watchDevices, type HueCreds, type Location } from '@musicsync/hue';
import { stageFixtures, stageSpace, type LiveState } from '@musicsync/protocol';
import type { EngineHost } from './engine-host.ts';
import type { Live } from './live.ts';
import type { Store } from './store.ts';

const RETRY_MS = 30_000;
/** Bridge events come in bursts (a new light sends several). */
const EVENT_DEBOUNCE_MS = 1000;

export class HueModule {
  private readonly store: Store;
  private readonly live: Live;
  private readonly engine: EngineHost;
  private creds: HueCreds | undefined;
  private watcher: { stop(): void } | undefined;
  private retry: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private lights: LiveState['hue']['lights'] = [];

  constructor(app: FastifyInstance, store: Store, live: Live, engine: EngineHost) {
    this.store = store;
    this.live = live;
    this.engine = engine;

    // One attempt per request: the wizard repeats it every 2 s while you press the button.
    app.post('/api/hue/pair', async (req, reply) => {
      const body = z.object({ ip: z.string().regex(/^[A-Za-z0-9.:-]{1,253}$/) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'Enter the bridge IP address' });
      let creds: HueCreds | undefined;
      try {
        creds = await pair(body.data.ip, 'musicsync#server');
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
      if (!creds) return { status: 'press-button' };
      this.store.setSecret('hue', creds);
      await this.connect(creds);
      return { status: 'paired' };
    });
  }

  /** At startup: reconnect to the bridge paired earlier, if any. */
  async load(): Promise<void> {
    let creds: HueCreds | undefined;
    try {
      creds = this.store.getSecret<HueCreds>('hue');
    } catch (err) {
      this.live.patch({ hue: { paired: false, lights: [], devices: [], error: (err as Error).message } });
      return;
    }
    if (creds) await this.connect(creds);
  }

  private connect(creds: HueCreds): Promise<void> {
    this.creds = creds;
    this.watcher?.stop();
    this.watcher = watchDevices(creds, () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.resync(), EVENT_DEBOUNCE_MS);
    });
    return this.resync();
  }

  /** Brings the area in line with the bridge and the layout. Runs one at a time. */
  resync(): Promise<void> {
    this.queue = this.queue.then(() => this.sync());
    return this.queue;
  }

  /** Group faders → a level per channel. */
  sendGains(): void {
    const { layout, master } = this.live.state;
    const gains = this.lights.map((light) =>
      layout.groups.reduce((g, group) => (light.id && group.fixtureIds.includes(light.id) ? g * (master.groups[group.id] ?? 1) : g), 1),
    );
    this.engine.send({ type: 'gains', gains });
  }

  private async sync(): Promise<void> {
    const creds = this.creds;
    if (!creds) return;
    clearTimeout(this.retry);
    const bridge = { paired: true, bridgeIp: creds.bridgeIp, bridgeId: creds.bridgeId };
    const { layout } = this.live.state;
    let warning: string | undefined;
    let locations: Location[] = [];
    try {
      const { area, devices } = await syncArea(
        creds,
        (devices) => {
          const streamable = new Set(devices.filter((d) => d.streamable).map((d) => d.id));
          const fixtures = stageFixtures(layout).filter((f) => streamable.has(f.id));
          if (fixtures.length === 0) return undefined; // nothing placed yet: leave the area as it is
          if (fixtures.length > AREA_MAX) {
            warning = `The stage has ${fixtures.length} lights, but an Entertainment area holds ${AREA_MAX}: only the first ${AREA_MAX} take part.`;
          }
          locations = stageSpace(layout.stage, fixtures.slice(0, AREA_MAX));
          return locations;
        },
        () => this.engine.pauseOutput(),
      );
      this.lights = area.lights;
      this.live.patch({ hue: { ...bridge, lights: area.lights, devices, warning } });
      const byId = new Map(locations.map((l) => [l.id, l]));
      const positions = area.lights.map((l) => (l.id ? byId.get(l.id) : undefined));
      const channels = area.lights.map((l) => l.channel);
      this.engine.send({
        type: 'output',
        hue: { creds, areaId: area.id, channels },
        layout: positions.every(Boolean) ? (positions as Position[]) : area.lights.length,
      });
      this.sendGains();
    } catch (err) {
      const { lights, devices } = this.live.state.hue;
      this.live.patch({ hue: { ...bridge, lights, devices, error: (err as Error).message } });
      this.retry = setTimeout(() => void this.resync(), RETRY_MS);
    }
  }
}
