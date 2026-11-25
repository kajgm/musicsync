import { describe, expect, it } from 'vitest';
import type { LiveState } from '@musicsync/protocol';
import { delayKey } from './analysis.ts';

const last = { key: 'old', label: 'Old', ms: 0 };
const state = (s: Partial<LiveState>) => ({ mode: 'idle', agent: { connected: false }, spotify: { playing: false }, ...s }) as LiveState;

describe('delayKey', () => {
  it('follows the PC while it plays there, and the Spotify device otherwise', () => {
    const pc = { connected: true, device: 'HDMI' };
    expect(delayKey(state({ mode: 'full', agent: pc }), last).key).toBe('pc:HDMI');
    const phone = { playing: true, device: { name: 'iPhone', type: 'Smartphone' } } as LiveState['spotify'];
    expect(delayKey(state({ mode: 'spotify-only', agent: pc, spotify: phone }), last)).toEqual({ key: 'spotify:iPhone', label: 'iPhone' });
  });

  it('keeps the last device when nothing plays', () => {
    expect(delayKey(state({}), last).key).toBe('old');
  });
});
