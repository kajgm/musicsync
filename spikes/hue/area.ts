// Spike 1b: list lights and Entertainment areas over CLIP v2, and create a
// "musicsync" area from every entertainment-capable light if it doesn't exist.
// Usage: npm run hue:area
import { clip, type EntertainmentConfig, type EntertainmentService, type Light } from '../lib/hue.ts';

export const AREA_NAME = 'musicsync';

const [lights, services, areas] = await Promise.all([
  clip<Light>('GET', 'light'),
  clip<EntertainmentService>('GET', 'entertainment'),
  clip<EntertainmentConfig>('GET', 'entertainment_configuration'),
]);

const lightNameByDevice = new Map(lights.map((l) => [l.owner.rid, l.metadata.name]));
const renderers = services.filter((s) => s.renderer);

console.log(`Lights: ${lights.length}, entertainment-capable: ${renderers.length}`);
for (const l of lights) {
  const capable = renderers.some((s) => s.owner.rid === l.owner.rid);
  console.log(`  ${l.metadata.name.padEnd(30)} gamut ${(l.color?.gamut_type ?? '-').padEnd(5)} ${capable ? 'entertainment' : 'no entertainment'}`);
}
console.log(
  `Existing Entertainment areas: ${
    areas.length ? areas.map((a) => `"${a.metadata.name}" (${a.status}, ${a.channels.length} channels)`).join(', ') : 'none'
  }`,
);

let area = areas.find((a) => a.metadata.name === AREA_NAME);
if (area) {
  console.log(`Reusing area "${AREA_NAME}" (${area.id}).`);
} else {
  // Spread the bulbs along a line for now; Phase 2 positions them from the floor plan.
  const n = renderers.length;
  const xAt = (i: number) => (n === 1 ? 0 : -1 + (2 * i) / (n - 1));
  const create = (positionKey: 'positions' | 'position') =>
    clip<{ rid: string }>('POST', 'entertainment_configuration', {
      type: 'entertainment_configuration',
      metadata: { name: AREA_NAME },
      configuration_type: 'music',
      locations: {
        service_locations: renderers.map((s, i) => {
          const pos = { x: xAt(i), y: 0.8, z: 0 };
          return { service: { rid: s.id, rtype: 'entertainment' }, [positionKey]: positionKey === 'positions' ? [pos] : pos };
        }),
      },
    });
  let created: Array<{ rid: string }>;
  try {
    created = await create('positions');
  } catch (err) {
    console.log(`  "positions" form rejected (${(err as Error).message}); retrying with "position".`);
    created = await create('position');
  }
  const rid = created[0]?.rid;
  if (!rid) throw new Error('Bridge returned no id for the new area');
  console.log(`Created Entertainment area "${AREA_NAME}" (${rid}).`);
  area = (await clip<EntertainmentConfig>('GET', `entertainment_configuration/${rid}`))[0];
}

if (!area) throw new Error('Area lookup failed');
console.log(`Channels in "${AREA_NAME}":`);
for (const ch of area.channels) {
  const service = services.find((s) => s.id === ch.members[0]?.service.rid);
  const name = lightNameByDevice.get(service?.owner.rid ?? '') ?? '?';
  console.log(`  channel ${ch.channel_id}: ${name.padEnd(30)} x=${ch.position.x.toFixed(2)} y=${ch.position.y.toFixed(2)} z=${ch.position.z.toFixed(2)}`);
}
