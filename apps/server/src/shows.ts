// shows (architecture §4.4, §6.3 library): one show per Spotify track, each its own
// versioned document (`show:<trackId>`), plus an index for listing. Import/export is the
// same JSON.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Show, type ShowSummary } from '@musicsync/protocol';
import type { Store } from './store.ts';

const TrackId = z.object({ trackId: z.string().regex(/^[A-Za-z0-9]{1,64}$/) });
const SHOW_MAX_BYTES = 2 * 1024 * 1024;

const summary = (s: Show): ShowSummary => ({
  trackId: s.trackId,
  name: s.name,
  track: s.track,
  enabled: s.enabled,
  clips: s.lanes.reduce((n, l) => n + l.clips.length, 0),
});

export class Shows {
  private readonly store: Store;
  private readonly cache = new Map<string, Show>();
  private readonly onChange: () => void;

  constructor(app: FastifyInstance, store: Store, onChange: () => void) {
    this.store = store;
    this.onChange = onChange;
    for (const id of this.index()) {
      const parsed = Show.safeParse(store.get(`show:${id}`));
      if (parsed.success) this.cache.set(id, parsed.data);
    }

    app.get('/api/shows', async () => [...this.cache.values()].map(summary));

    app.get('/api/shows/:trackId', async (req, reply) => {
      const { trackId } = TrackId.parse(req.params);
      return this.cache.get(trackId) ?? reply.code(404).send({ error: 'No show for this track' });
    });

    // `?import=1` replaces whatever is there (a file from Export); otherwise `rev` must match.
    app.put('/api/shows/:trackId', { bodyLimit: SHOW_MAX_BYTES }, async (req, reply) => {
      const { trackId } = TrackId.parse(req.params);
      const parsed = Show.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: `Not saved: ${parsed.error.issues[0]?.message}` });
      if (parsed.data.trackId !== trackId) return reply.code(400).send({ error: 'The show is for another track' });
      const current = this.cache.get(trackId);
      const importing = (req.query as { import?: string }).import === '1';
      if (!importing && parsed.data.rev !== (current?.rev ?? 0)) {
        return reply.code(409).send({ error: 'The show changed on another device. Reload it and make the change again.' });
      }
      const next = { ...parsed.data, rev: (current?.rev ?? 0) + 1 };
      this.save(next);
      return { rev: next.rev };
    });

    app.delete('/api/shows/:trackId', async (req, reply) => {
      const { trackId } = TrackId.parse(req.params);
      this.cache.delete(trackId);
      this.store.delete(`show:${trackId}`);
      this.store.set('shows', [...this.cache.keys()]);
      this.onChange();
      return reply.code(204).send();
    });
  }

  get(trackId: string | undefined): Show | undefined {
    return trackId ? this.cache.get(trackId) : undefined;
  }

  private index(): string[] {
    return this.store.get<string[]>('shows') ?? [];
  }

  private save(show: Show): void {
    this.cache.set(show.trackId, show);
    this.store.set(`show:${show.trackId}`, show);
    this.store.set('shows', [...this.cache.keys()]);
    this.onChange();
  }
}
