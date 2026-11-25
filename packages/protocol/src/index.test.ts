import { describe, expect, it } from 'vitest';
import { EMPTY_LAYOUT, Layout, stageFixtures, stageSpace, type Fixture } from './index.ts';

const fixture = (id: string, x: number, y: number, z = 1.1, tags: string[] = []): Fixture => ({ id, floorId: 'f1', x, y, z, tags });

describe('stageSpace', () => {
  const stage = { ...EMPTY_LAYOUT.stage, listen: { x: 5, y: 5 }, earHeight: 1 };

  it('maps the plan to right/front/up as seen from the listener, farthest light at ±1', () => {
    const [ahead, right, high] = stageSpace(stage, [fixture('a', 5, 3, 1), fixture('r', 6, 5, 1), fixture('h', 5, 5, 2)]);
    expect(ahead).toEqual({ id: 'a', x: 0, y: 1, z: 0 }); // plan y points down, so up the plan is in front
    expect(right).toEqual({ id: 'r', x: 0.5, y: 0, z: 0 });
    expect(high).toEqual({ id: 'h', x: 0, y: 0, z: 0.5 });
  });

  it('turns with the facing direction', () => {
    const [east] = stageSpace({ ...stage, facingDeg: 90 }, [fixture('e', 7, 5, 1)]);
    expect(east).toEqual({ id: 'e', x: 0, y: 1, z: 0 });
    const [south] = stageSpace({ ...stage, facingDeg: 90 }, [fixture('s', 5, 7, 1)]);
    expect(south).toEqual({ id: 's', x: 1, y: 0, z: 0 });
  });
});

describe('stageFixtures', () => {
  it('takes every placed light on the floor, or only tagged ones', () => {
    const layout: Layout = {
      ...EMPTY_LAYOUT,
      floors: [...EMPTY_LAYOUT.floors, { id: 'f2', name: 'Up', elevation: 3 }],
      fixtures: [fixture('a', 0, 0, 1, ['sync']), fixture('b', 1, 1), { ...fixture('c', 0, 0, 1, ['sync']), floorId: 'f2' }],
    };
    expect(stageFixtures(layout).map((f) => f.id)).toEqual(['a', 'b']);
    expect(stageFixtures({ ...layout, stage: { ...layout.stage, tags: ['sync'] } }).map((f) => f.id)).toEqual(['a']);
  });
});

describe('Layout', () => {
  it('refuses unknown floors and duplicate ids', () => {
    expect(Layout.safeParse(EMPTY_LAYOUT).success).toBe(true);
    expect(Layout.safeParse({ ...EMPTY_LAYOUT, fixtures: [{ ...fixture('a', 0, 0), floorId: 'nope' }] }).success).toBe(false);
    expect(Layout.safeParse({ ...EMPTY_LAYOUT, fixtures: [fixture('a', 0, 0), fixture('a', 1, 1)] }).success).toBe(false);
  });
});
