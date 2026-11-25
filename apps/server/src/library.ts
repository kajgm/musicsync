// library module (architecture §6.3): looks, track/playlist/artist → look rules, the
// default look and the auto-start setting, saved as one validated document like the layout.
import type { FastifyInstance } from 'fastify';
import { RAINBOW } from '@musicsync/engine';
import { ALL, Library, type Look, type LookLayer } from '@musicsync/protocol';
import type { Live } from './live.ts';
import type { Store } from './store.ts';

const layer = (id: string, effect: string, blend: LookLayer['blend'], params: LookLayer['params'], opacity = 1): LookLayer => ({
  id,
  enabled: true,
  effect,
  target: ALL,
  blend,
  opacity,
  params,
});
const bass = (lo: number, hi: number) => ({ bind: 'audio.bass', range: [lo, hi] as [number, number], curve: 'linear' as const, attackMs: 0, releaseMs: 0 });

export const BUILTIN_LOOKS: Look[] = [
  {
    id: 'pulse',
    name: 'Pulse',
    palette: { source: 'fixed', colors: RAINBOW },
    layers: [layer('wash', 'wash', 'normal', { brightness: bass(0.12, 0.9) }), layer('flash', 'flash', 'screen', { strength: 0.7 })],
    overrides: [],
  },
  {
    id: 'wave',
    name: 'Wave',
    palette: { source: 'fixed', colors: RAINBOW },
    layers: [layer('wash', 'wash', 'normal', { brightness: bass(0.12, 0.9) }), layer('flash', 'flash', 'screen', { strength: 0.7, rippleMs: 260 })],
    overrides: [],
  },
  {
    id: 'album',
    name: 'Album glow',
    palette: { source: 'album', colors: RAINBOW },
    layers: [
      layer('wash', 'wash', 'normal', {
        spread: 0.6,
        drift: 0.5,
        kickStep: 0.2,
        brightness: { bind: 'audio.band', range: [0.1, 1], curve: 'linear', attackMs: 0, releaseMs: 150 },
      }),
      layer('breathe', 'breathe', 'multiply', { depth: 0.25 }),
      layer('sparkle', 'sparkle', 'add', { density: 0.3 }, 0.8),
    ],
    overrides: [],
  },
  {
    id: 'ambient',
    name: 'Ambient',
    palette: { source: 'album', colors: RAINBOW },
    layers: [
      layer('wash', 'wash', 'normal', {
        spread: 0.5,
        drift: 2,
        kickStep: 0,
        brightness: { bind: 'audio.level', range: [0.2, 0.6], curve: 'log', attackMs: 300, releaseMs: 1500 },
      }),
    ],
    overrides: [],
  },
];

export const DEFAULT_LIBRARY: Library = { rev: 0, looks: BUILTIN_LOOKS, rules: [], defaultLookId: 'pulse', autoStart: true };

export function loadLibrary(store: Store): Library {
  const parsed = Library.safeParse(store.get('library'));
  return parsed.success ? parsed.data : DEFAULT_LIBRARY;
}

export function registerLibrary(app: FastifyInstance, store: Store, live: Live): void {
  app.put('/api/library', { bodyLimit: 512 * 1024 }, async (req, reply) => {
    const parsed = Library.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `Not saved: ${parsed.error.issues[0]?.message}` });
    const current = live.state.library;
    if (parsed.data.rev !== current.rev) {
      return reply.code(409).send({ error: 'The looks changed on another device. Your view is up to date now; make the change again.' });
    }
    const next = { ...parsed.data, rev: current.rev + 1 };
    store.set('library', next);
    live.patch({ library: next });
    return { rev: next.rev };
  });
}
