import { describe, expect, it } from 'vitest';
import { ALL, EMPTY_LAYOUT, type Layout, type LiveState, type Show } from '@musicsync/protocol';
import { compileLook, compileShow, pickLook, resolveProfile } from './director.ts';
import { BUILTIN_LOOKS, DEFAULT_LIBRARY } from './library.ts';
import { paletteFromPixels } from './palette.ts';

const layout: Layout = {
  ...EMPTY_LAYOUT,
  fixtures: [
    { id: 'lamp', floorId: 'f1', x: 1, y: 1, z: 1, tags: ['lamp'], response: { sensitivity: 0.5, band: 'mid' } },
    { id: 'strip', floorId: 'f1', x: 3, y: 1, z: 1, tags: ['strip'] },
  ],
  groups: [{ id: 'g', name: 'Shelf', fixtureIds: ['strip'], response: { latencyMs: 40 } }],
};
const pulse = BUILTIN_LOOKS[0];

describe('resolveProfile', () => {
  it('layers the light’s own, its groups’ and the look’s settings over the defaults', () => {
    expect(resolveProfile('lamp', layout, pulse)).toMatchObject({ sensitivity: 0.5, band: 'mid', latencyMs: 0, max: 1 });
    expect(resolveProfile('strip', layout, pulse)).toMatchObject({ sensitivity: 1, latencyMs: 40 });
    const look = { ...pulse, overrides: [{ target: { tags: ['lamp'], groups: [], fixtures: [] }, response: { sensitivity: 2 } }] };
    expect(resolveProfile('lamp', layout, look).sensitivity).toBe(2);
    expect(resolveProfile('strip', layout, look).sensitivity).toBe(1);
  });
});

describe('compileLook', () => {
  it('targets layers by tag and group, and skips disabled ones', () => {
    const look = {
      ...pulse,
      layers: [
        { ...pulse.layers[0], target: { tags: ['lamp'], groups: [], fixtures: [] } },
        { ...pulse.layers[1], target: { tags: [], groups: ['g'], fixtures: [] } },
        { ...pulse.layers[1], id: 'off', enabled: false },
      ],
    };
    const program = compileLook(look, layout, ['strip', 'lamp', undefined], pulse.palette.colors, 'k');
    expect(program.layers.map((l) => l.channels)).toEqual([[1], [0]]);
    expect(program.profiles[1].band).toBe('mid');
  });
});

describe('compileShow', () => {
  const show: Show = {
    schemaVersion: 1,
    rev: 0,
    trackId: 't1',
    track: { name: 'Song', artists: 'A', durationMs: 200_000 },
    name: 'Song show',
    enabled: true,
    bedLookId: null,
    palette: pulse.palette,
    lanes: [
      {
        id: 'l1',
        name: 'Lamps',
        enabled: true,
        target: { tags: ['lamp'], groups: [], fixtures: [] },
        blend: 'screen',
        opacity: 0.8,
        clips: [
          {
            id: 'c1',
            start: { ms: 1000, beat: 4 },
            end: { ms: 3000 },
            effect: 'solid',
            params: { color: 1, brightness: { keyframes: [{ ms: 0, value: 0 }, { ms: 500, value: 1 }] } },
            fadeInMs: 100,
            fadeOutMs: 0,
          },
        ],
      },
      { id: 'off', name: 'Off', enabled: false, target: ALL, blend: 'normal', opacity: 1, clips: [] },
    ],
  };

  it('turns clips into windowed, automated layers on their lane’s lights', () => {
    const program = compileShow(show, undefined, layout, ['strip', 'lamp'], pulse.palette.colors, undefined, 'k');
    expect(program.layers).toHaveLength(1);
    const [clip] = program.layers;
    expect(clip.channels).toEqual([1]);
    expect(clip.window).toEqual({ startMs: 1000, endMs: 3000, fadeInMs: 100, fadeOutMs: 0 });
    expect(clip.params).toEqual({ color: 1 });
    expect(clip.automation).toEqual({ brightness: [[0, 0], [500, 1]] });
  });

  it('places beat-snapped times on the grid, with the bed look underneath', () => {
    const program = compileShow(show, pulse, layout, ['strip', 'lamp'], pulse.palette.colors, { periodMs: 500, offsetMs: 120 }, 'k');
    expect(program.layers.map((l) => l.effect)).toEqual(['wash', 'flash', 'solid']);
    expect(program.layers[2].window?.startMs).toBe(120 + 4 * 500);
  });

  it('wins over rules but not over a manual pick', () => {
    const state = { library: DEFAULT_LIBRARY, spotify: {} } as unknown as LiveState;
    expect(pickLook(state, undefined, show).reason).toBe('show');
    expect(pickLook(state, 'wave', show).reason).toBe('manual');
  });
});

describe('pickLook', () => {
  const track = { id: 't1', name: 'Song', artists: 'A', artistList: [{ uri: 'spotify:artist:a', name: 'A' }], album: '', durationMs: 1000 };
  const state = (rules: LiveState['library']['rules'], context?: string) =>
    ({ library: { ...DEFAULT_LIBRARY, rules }, spotify: { track, context: context ? { uri: context, type: 'playlist' } : undefined } }) as unknown as LiveState;
  const rule = (kind: 'track' | 'playlist' | 'artist', uri: string, lookId: string) => ({ id: kind, kind, uri, label: kind, lookId });

  it('prefers a manual pick, then track, playlist and artist rules, then the default', () => {
    const rules = [rule('artist', 'spotify:artist:a', 'ambient'), rule('playlist', 'spotify:playlist:p', 'album'), rule('track', 'spotify:track:t1', 'wave')];
    expect(pickLook(state(rules, 'spotify:playlist:p'), 'album')).toEqual({ lookId: 'album', reason: 'manual' });
    expect(pickLook(state(rules, 'spotify:playlist:p'), undefined)).toEqual({ lookId: 'wave', reason: 'track' });
    expect(pickLook(state(rules.slice(0, 2), 'spotify:playlist:p'), undefined)).toEqual({ lookId: 'album', reason: 'playlist' });
    expect(pickLook(state(rules.slice(0, 1)), undefined)).toEqual({ lookId: 'ambient', reason: 'artist' });
    expect(pickLook(state([]), undefined)).toEqual({ lookId: 'pulse', reason: 'default' });
  });
});

describe('paletteFromPixels', () => {
  it('finds the main colours of a cover and ignores grey', () => {
    const px = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) {
      const [r, g, b] = i < 1500 ? [220, 30, 40] : i < 3000 ? [30, 60, 220] : [128, 128, 128];
      px.set([r, g, b, 255], i * 4);
    }
    const hues = paletteFromPixels(px)!.map((c) => c.h);
    expect(hues.some((h) => h < 40 || h > 340)).toBe(true); // red
    expect(hues.some((h) => h > 240 && h < 290)).toBe(true); // blue
    expect(paletteFromPixels(new Uint8Array(64 * 64 * 4).fill(128))).toBeUndefined();
  });
});
