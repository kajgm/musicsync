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
});
export type Master = z.infer<typeof Master>;

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('master'), master: Master.partial() }),
  z.object({ type: z.literal('run'), running: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

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
    /** The Entertainment area's channels, in stream order. */
    lights: Array<{ channel: number; name: string }>;
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
  agent: { connected: boolean; device?: string; framesPerSec?: number };
  output: { status: 'off' | 'connecting' | 'streaming' | 'error' | 'no-bridge'; fps: number; error?: string };
};

export type ServerMessage =
  | { type: 'state'; state: LiveState }
  /** Preview at ~25 Hz: one CSS hex color per light, in `hue.lights` order. */
  | { type: 'frame'; colors: string[] };
