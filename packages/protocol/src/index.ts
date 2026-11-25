// Messages between the server, the web app (live bus) and the loopback agent (sensor
// protocol). Everything arriving from a client is parsed with these schemas.
import { z } from 'zod';

// ---- Sensor protocol: loopback agent → server (WSS /api/agent) ----

/** Number of frequency bands in a feature frame (log-spaced, 40 Hz – 16 kHz). */
export const BAND_COUNT = 8;

export const AgentHello = z.object({
  type: z.literal('hello'),
  token: z.string().max(200),
  /** The Windows output device being captured. */
  device: z.string().max(200),
  version: z.string().max(40),
});

export const AgentPing = z.object({ type: z.literal('ping'), t0: z.number() });

/** One analysis hop (~10 ms of audio). `t` is server time (epoch ms) of the hop's last sample. */
export const AgentFrame = z.object({
  type: z.literal('frame'),
  t: z.number(),
  rms: z.number().min(0),
  /** Energy per band in dB. */
  bands: z.array(z.number()).length(BAND_COUNT),
  /** Onset strength: positive spectral change, all bins and below 200 Hz. */
  flux: z.number().min(0),
  lowFlux: z.number().min(0),
});

export const AgentMessage = z.discriminatedUnion('type', [AgentHello, AgentPing, AgentFrame]);
export type AgentMessage = z.infer<typeof AgentMessage>;
export type AgentFrame = z.infer<typeof AgentFrame>;

/** Server → agent. `pong.t` is server time when the ping was answered. */
export type ServerToAgent = { type: 'welcome' } | { type: 'pong'; t0: number; t: number };

// ---- Live bus: web app ↔ server (WSS /api/live) ----

export const Master = z.object({
  brightness: z.number().min(0).max(1),
  /** How strongly the lights react to the music; 0 = steady ambient light. */
  intensity: z.number().min(0).max(1),
  blackout: z.boolean(),
  /** Delays the lights behind the captured audio, set by ear for the speaker. */
  delayMs: z.number().int().min(0).max(1000),
  look: z.enum(['pulse', 'wave']),
  /** Fader level per group id; a light in several groups gets the product. Missing = 1. */
  groups: z.record(z.string().max(64), z.number().min(0).max(1)),
});
export type Master = z.infer<typeof Master>;

export const DEFAULT_MASTER: Master = { brightness: 0.8, intensity: 0.8, blackout: false, delayMs: 0, look: 'pulse', groups: {} };

/** Pulse: colours drift across the room, kicks flash. Wave: kicks ripple out from where you sit. */
export const LOOKS: Record<Master['look'], string> = { pulse: 'Pulse', wave: 'Wave' };

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('master'), master: Master.partial() }),
  z.object({ type: z.literal('run'), running: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- Layout (architecture §4.2): metres on a floor plan seen from above, y pointing down ----

const Id = z.string().min(1).max(64);
const Name = z.string().trim().min(1).max(60);
const Tags = z.array(z.string().trim().min(1).max(30)).max(20);
const Metres = z.number().min(-1000).max(1000);
export const Point = z.object({ x: Metres, y: Metres });

export const Floor = z.object({
  id: Id,
  name: Name,
  /** Height of the floor above ground, metres. */
  elevation: z.number().min(-50).max(500),
  /** Width in metres the plan image spans (sets its scale). Undefined = no image. */
  planWidthM: z.number().positive().max(1000).optional(),
});
export const Room = z.object({ id: Id, floorId: Id, name: Name, polygon: z.array(Point).min(3).max(64) });
/** A placed light. `id` is the bridge's entertainment service id. */
export const Fixture = z.object({
  id: Id,
  floorId: Id,
  x: Metres,
  y: Metres,
  /** Height above the floor, metres. */
  z: z.number().min(0).max(20),
  tags: Tags,
});
export const Group = z.object({ id: Id, name: Name, fixtureIds: z.array(Id).max(200) });
/** Where you listen from. Its lights make up the app's Entertainment area. */
export const Stage = z.object({
  floorId: Id,
  listen: Point,
  /** Direction you face, degrees clockwise from the plan's up. */
  facingDeg: z.number().min(-360).max(360),
  /** Ear height above the floor, metres. */
  earHeight: z.number().min(0).max(5),
  /** Placed lights with any of these tags join; empty = every placed light on the floor. */
  tags: Tags,
});
export const Layout = z
  .object({
    /** Increments on every save; a save based on an older rev is refused. */
    rev: z.number().int().min(0),
    floors: z.array(Floor).min(1).max(20),
    rooms: z.array(Room).max(100),
    fixtures: z.array(Fixture).max(200),
    groups: z.array(Group).max(50),
    stage: Stage,
  })
  .superRefine((l, ctx) => {
    const floors = new Set(l.floors.map((f) => f.id));
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const list of [l.floors, l.rooms, l.fixtures, l.groups] as Array<Array<{ id: string }>>) {
      if (new Set(list.map((x) => x.id)).size !== list.length) issue('Duplicate id');
    }
    for (const x of [...l.rooms, ...l.fixtures, l.stage]) if (!floors.has(x.floorId)) issue(`Unknown floor ${x.floorId}`);
  });
export type Point = z.infer<typeof Point>;
export type Floor = z.infer<typeof Floor>;
export type Room = z.infer<typeof Room>;
export type Fixture = z.infer<typeof Fixture>;
export type Group = z.infer<typeof Group>;
export type Stage = z.infer<typeof Stage>;
export type Layout = z.infer<typeof Layout>;

export const EMPTY_LAYOUT: Layout = {
  rev: 0,
  floors: [{ id: 'f1', name: 'Home', elevation: 0 }],
  rooms: [],
  fixtures: [],
  groups: [],
  stage: { floorId: 'f1', listen: { x: 2, y: 2 }, facingDeg: 0, earHeight: 1.1, tags: [] },
};

/** Placed lights that join the stage (and so the Entertainment area). */
export function stageFixtures(layout: Layout): Fixture[] {
  const { floorId, tags } = layout.stage;
  return layout.fixtures.filter((f) => f.floorId === floorId && (tags.length === 0 || f.tags.some((t) => tags.includes(t))));
}

/**
 * Positions as seen from the listening position, in Hue's −1..1 space: x right, y front,
 * z up. One scale for all axes keeps the room's proportions; the farthest light lands on ±1.
 */
export function stageSpace(stage: Stage, fixtures: Fixture[]): Array<{ id: string; x: number; y: number; z: number }> {
  const a = (stage.facingDeg * Math.PI) / 180;
  const rel = fixtures.map((f) => {
    const dx = f.x - stage.listen.x;
    const dy = f.y - stage.listen.y; // plan y points down
    return {
      id: f.id,
      x: dx * Math.cos(a) + dy * Math.sin(a),
      y: dx * Math.sin(a) - dy * Math.cos(a),
      z: f.z - stage.earHeight,
    };
  });
  const scale = Math.max(0.5, ...rel.flatMap((p) => [Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)]));
  const round = (v: number) => Math.round((v / scale) * 1000) / 1000 + 0; // + 0 turns −0 into 0
  return rel.map((p) => ({ id: p.id, x: round(p.x), y: round(p.y), z: round(p.z) }));
}

export type Track = {
  id: string;
  name: string;
  artists: string;
  album: string;
  artUrl?: string;
  durationMs: number;
};

export type LiveState = {
  /** Streaming to the lights. The preview runs either way. */
  running: boolean;
  master: Master;
  /** full: live PC audio drives the look. spotify-only: playing on another device. */
  mode: 'full' | 'spotify-only' | 'idle';
  hue: {
    paired: boolean;
    bridgeIp?: string;
    bridgeId?: string;
    /** The Entertainment area's channels, in stream order. `id`: entertainment service id. */
    lights: Array<{ channel: number; name: string; id?: string }>;
    /** Every light on the bridge, kept current by its event stream. */
    devices: Array<{ id: string; name: string; streamable: boolean }>;
    /** The layout asks for something the area can't do (e.g. more than 10 lights). */
    warning?: string;
    error?: string;
  };
  spotify: {
    /** SPOTIFY_CLIENT_ID is set. */
    configured: boolean;
    /** Register this in the Spotify app's settings. */
    redirectUri: string;
    linked: boolean;
    playing: boolean;
    device?: { name: string; type: string };
    track?: Track;
    /** Track position at server time `at` (epoch ms). */
    progressMs?: number;
    at?: number;
    error?: string;
  };
  layout: Layout;
  agent: { connected: boolean; device?: string; framesPerSec?: number };
  output: { status: 'off' | 'connecting' | 'streaming' | 'error' | 'no-bridge'; fps: number; error?: string };
};

export type ServerMessage =
  | { type: 'state'; state: LiveState }
  /** Preview at ~25 Hz: one CSS hex color per light, in `hue.lights` order. */
  | { type: 'frame'; colors: string[] };
