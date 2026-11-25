// layout module (architecture §4.2, §6.3): floors, rooms, placed lights, tags, groups and
// the stage, saved as one validated document; plus each floor's plan image.
// The document goes to every client in the live state; the editor saves it whole.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EMPTY_LAYOUT, Layout } from '@musicsync/protocol';
import type { Live } from './live.ts';
import type { Store } from './store.ts';

const PLAN_TYPES = ['image/png', 'image/jpeg', 'image/webp']; // no SVG: it could run script on our origin
const PLAN_MAX_BYTES = 4 * 1024 * 1024;

export function loadLayout(store: Store): Layout {
  const parsed = Layout.safeParse(store.get('layout'));
  return parsed.success ? parsed.data : EMPTY_LAYOUT;
}

export function registerLayout(app: FastifyInstance, store: Store, live: Live, onChange: () => void): void {
  app.put('/api/layout', async (req, reply) => {
    const parsed = Layout.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `Layout not saved: ${parsed.error.issues[0]?.message}` });
    const current = live.state.layout;
    if (parsed.data.rev !== current.rev) {
      return reply.code(409).send({ error: 'The layout changed on another device. Your view is up to date now; make the change again.' });
    }
    const next = { ...parsed.data, rev: current.rev + 1 };
    store.set('layout', next);
    for (const floor of current.floors) {
      const kept = next.floors.find((f) => f.id === floor.id);
      if (!kept?.planWidthM) store.delete(`plan:${floor.id}`);
    }
    live.patch({ layout: next });
    onChange();
    return { rev: next.rev };
  });

  app.addContentTypeParser(PLAN_TYPES, { parseAs: 'buffer', bodyLimit: PLAN_MAX_BYTES }, (_req, body, done) => done(null, body));

  const Params = z.object({ floorId: z.string().min(1).max(64) });

  app.put('/api/plan/:floorId', { bodyLimit: PLAN_MAX_BYTES }, async (req, reply) => {
    const { floorId } = Params.parse(req.params);
    const type = req.headers['content-type'] ?? '';
    if (!live.state.layout.floors.some((f) => f.id === floorId)) return reply.code(404).send({ error: 'No such floor' });
    if (!PLAN_TYPES.includes(type) || !Buffer.isBuffer(req.body)) {
      return reply.code(415).send({ error: 'Use a PNG, JPEG or WebP image' });
    }
    store.set(`plan:${floorId}`, { type, data: req.body.toString('base64') });
    return reply.code(204).send();
  });

  app.get('/api/plan/:floorId', async (req, reply) => {
    const { floorId } = Params.parse(req.params);
    const plan = store.get<{ type: string; data: string }>(`plan:${floorId}`);
    if (!plan) return reply.code(404).send({ error: 'No plan image' });
    return reply
      .type(plan.type)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=31536000, immutable') // the URL carries a version
      .send(Buffer.from(plan.data, 'base64'));
  });
}
