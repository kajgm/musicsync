// devices module, Phase 1: pair with the bridge (link button), find or create the app's
// Entertainment area and point the engine at it.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensureArea, pair, type HueCreds } from '@musicsync/hue';
import type { EngineHost } from './engine-host.ts';
import type { Live } from './live.ts';
import type { Store } from './store.ts';

const RETRY_MS = 30_000;

export class HueModule {
  private readonly store: Store;
  private readonly live: Live;
  private readonly engine: EngineHost;
  private retry: NodeJS.Timeout | undefined;

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
      this.live.patch({ hue: { paired: false, lights: [], error: (err as Error).message } });
      return;
    }
    if (creds) await this.connect(creds);
  }

  private async connect(creds: HueCreds): Promise<void> {
    clearTimeout(this.retry);
    const bridge = { paired: true, bridgeIp: creds.bridgeIp, bridgeId: creds.bridgeId };
    try {
      const area = await ensureArea(creds);
      this.live.patch({ hue: { ...bridge, lights: area.lights } });
      this.engine.send({
        type: 'output',
        hue: { creds, areaId: area.id, channels: area.lights.map((l) => l.channel) },
        channels: area.lights.length,
      });
    } catch (err) {
      this.live.patch({ hue: { ...bridge, lights: [], error: (err as Error).message } });
      this.retry = setTimeout(() => void this.connect(creds), RETRY_MS);
    }
  }
}
