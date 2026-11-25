import { describe, expect, it } from 'vitest';
import type { LiveState } from '@musicsync/protocol';
import { delayKey } from './analysis.ts';

const last = { key: 'old', label: 'Old', ms: 0 };
const state = (s: Partial<LiveState>) => ({ mode: 'idle', agent: { connected: false }, spotify: { playing: false }, ...s }) as LiveState;

describe('delayKey', () => {
  it('follows the PC while it plays there, and the Spotify device otherwise', () => {
    const pc = { connected: true, device: 'Speakers' };
    expect(delayKey(state({ mode: 'full', agent: pc }), last).key).toBe('pc:Speakers');
    const phone = { playing: true, device: { name: 'Phone', type: 'Smartphone' } } as LiveState['spotify'];
    expect(delayKey(state({ mode: 'spotify-only', agent: pc, spotify: phone }), last)).toEqual({ key: 'spotify:Phone', label: 'Phone' });
  });

  it('keeps the last device when nothing plays', () => {
    expect(delayKey(state({}), last).key).toBe('old');
  });
});

describe('AnalysisModule nudge', () => {
  it('keeps a nudge on the learned grid when this play is folded in again', async () => {
    const { AnalysisModule } = await import('./analysis.ts');
    const kv = new Map<string, unknown>([['grid:T1', { learned: { periodMs: 500, offsetMs: 100, confidence: 1, count: 100 } }]]);
    const store = { get: (k: string) => kv.get(k), set: (k: string, v: unknown) => kv.set(k, v), delete: (k: string) => kv.delete(k) };
    const live = {
      state: state({ mode: 'full', master: { delays: {} }, delay: last, beat: { source: 'none' }, spotify: { playing: true, track: { id: 'T1' } } } as Partial<LiveState>),
      onChange: () => undefined,
      patch(update: Partial<LiveState>) {
        Object.assign(this.state, update);
      },
    };
    const m = new AnalysisModule(store as never, live as never, { send: () => undefined } as never, { info: () => undefined } as never);
    m.update();
    const inner = m as unknown as { obs: Array<{ periodMs: number; posMs: number; weight: number }>; save(): void };
    // This play heard the beats where the learned grid has them.
    inner.obs = Array.from({ length: 50 }, (_, k) => ({ periodMs: 500, posMs: 100 + k * 500, weight: 1 }));
    inner.save();
    m.nudge(40);
    inner.save(); // the 30 s save after the nudge
    expect(m.gridFor('T1')?.offsetMs).toBeCloseTo(140, 0);
  });
});
